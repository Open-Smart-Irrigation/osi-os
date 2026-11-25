"""Host-only tests for the Pi 5 acceptance runner."""
from concurrent.futures import ThreadPoolExecutor
from contextlib import closing, redirect_stderr, redirect_stdout
from dataclasses import replace
import hashlib
import io
import json
import os
from pathlib import Path
import re
from shlex import quote
import shutil
import socket
import sqlite3
import subprocess
import tarfile
import tempfile
from types import SimpleNamespace
import time
import unittest
from unittest.mock import Mock, call, patch

import acceptance
from archives import verified_archive
import boot_safety
import customer_fixture
import minimal_flows
import radio_suite
import run
from suite_vm import FLOWS_COMMITTED, SLOW_BOOT_SECONDS, Guest, external_path
import tailscale_boot
import upgrade_suite


# PR #714 at 453207679276be8ef75fa64f6be85c2c6636585a.
PINNED_CAPABILITY = 'function persistFlowHold(stamp, reason) {'
DIGEST = b'a' * 64
COMMIT = b'node-red.init: committed flows.json digest=' + DIGEST + b' stamp=20261120T000000Z\r\n'


class RadioTests(unittest.TestCase):
    def run_log_script(self, script, root, ram_log):
        script = script.replace('/var/etc/chirpstack-concentratord/concentratord.toml',
                                quote(str(root/'concentratord.toml')))
        script = script.replace('/data/log/', quote(str(root)) + '/')
        fixture = f"logread() {{ printf '%s\\n' {quote(ram_log)}; }}\n"
        result = subprocess.run(['sh', '-c', fixture + script], capture_output=True, text=True)
        return result.returncode, result.stdout.strip()

    def request(self, wire):
        header = wire.read(8)
        self.assertEqual(header[1:], b'\xfe\x07\x35\xc8\x01\x60\x00')
        request_id = wire.read(run.RF_REQUEST_ID_SIZE)
        payload = wire.read(header[0])
        self.assertEqual(len(request_id), run.RF_REQUEST_ID_SIZE)
        self.assertEqual(len(payload), header[0])
        return request_id, payload

    def receipt(self, request_id, count, stamp=0):
        return (bytes((len(request_id) + 5, 254, 0)) + request_id + bytes((count,))
                + stamp.to_bytes(4, 'big'))

    def downlink(self, address, port=2):
        payload = b'\x60' + address.to_bytes(4, 'little') + b'\x00\x01\x00'
        payload += bytes((port,)) + b'\x41\x01\x00\x00\x00\x00'
        return payload, bytes((len(payload), 0, 7)) + payload

    def test_wrong_socket_can_accept_bytes_but_cannot_pass(self):
        host, wrong_peer = socket.socketpair()
        with host, wrong_peer, patch.object(radio_suite, 'RECEIPT_TIMEOUT', 0.01):
            with self.assertRaisesRegex(RuntimeError, 'no matching WM1302 model delivery receipt'):
                radio_suite.Radio(host).send(b'fixture')
            self.assertTrue(wrong_peer.recv(32))

    def test_model_receipt_counts_the_requested_frame(self):
        for count in (0, 1):
            with self.subTest(count=count):
                host, model = socket.socketpair()
                with host, model, ThreadPoolExecutor(1) as worker:
                    model.settimeout(2)

                    def reply():
                        with model.makefile('rb') as wire:
                            request_id, payload = self.request(wire)
                            self.assertEqual(payload, b'fixture')
                            model.sendall(self.receipt(request_id, count, stamp=0xfedcba98))

                    waiting = worker.submit(reply)
                    air = radio_suite.Radio(host)
                    if count:
                        self.assertEqual(air.send(b'fixture'), count)
                        self.assertEqual(air.last_stamp, 0xfedcba98)
                    else:
                        with self.assertRaisesRegex(RuntimeError, 'WM1302 model delivered zero frames'):
                            air.send(b'fixture')
                    waiting.result()

    def test_stale_receipt_cannot_count_for_a_later_injection(self):
        host, model = socket.socketpair()
        with host, model, ThreadPoolExecutor(1) as worker:
            model.settimeout(2)

            def reply_once():
                with model.makefile('rb') as wire:
                    request_id, payload = self.request(wire)
                    self.assertEqual(payload, b'first')
                    receipt = self.receipt(request_id, 1)
                    model.sendall(receipt + receipt)
                    next_id, payload = self.request(wire)
                    self.assertEqual(payload, b'second')
                    self.assertNotEqual(next_id, request_id)

            waiting = worker.submit(reply_once)
            air = radio_suite.Radio(host)
            self.assertEqual(air.send(b'first'), 1)
            with (patch.object(radio_suite, 'RECEIPT_TIMEOUT', 0.05),
                  self.assertRaisesRegex(RuntimeError, 'no matching WM1302 model delivery receipt')):
                air.send(b'second')
            waiting.result()

    def test_valve_ignores_pending_and_unrelated_packets_and_accepts_interleaving(self):
        host, model = socket.socketpair()
        valve = Mock(devaddr=1)
        valve.uplink.side_effect = [b'trigger receive window', b'report opened']
        valve.downlink.return_value = {'fport': 2, 'payload': b'\x41\x01'}
        command, command_wire = self.downlink(valve.devaddr)
        _, other_wire = self.downlink(2)
        _, mac_wire = self.downlink(valve.devaddr, port=0)
        vm = Mock()
        vm.command.side_effect = lambda script, *_: (0, '5 0' if '# attempt-marker' in script else
                                                     'match 81 1\nmatch 82 2\nmarked\nclosed\nram 2')
        with (host, model, ThreadPoolExecutor(1) as worker,
              patch.object(radio_suite, '_wait_history'),
              patch.object(radio_suite, 'EARLY_WINDOW_TIMEOUT', 0.01)):
            model.settimeout(2)
            model.sendall(self.receipt(b'old-id!!', 1) + command_wire)

            def reply():
                with model.makefile('rb') as wire:
                    request_id, payload = self.request(wire)
                    self.assertEqual(payload, b'trigger receive window')
                    model.sendall(mac_wire + command_wire + self.receipt(request_id, 1))
                    request_id, payload = self.request(wire)
                    self.assertEqual(payload, b'report opened')
                    model.sendall(self.receipt(request_id, 1))

            waiting = worker.submit(reply)
            air = radio_suite.Radio(host)
            result = radio_suite.run_valve(vm, air, {radio_suite.VALVE: valve},
                                          lambda: model.sendall(other_wire + mac_wire))
            self.assertEqual(result, 'WM1302 model delivered=2, Concentratord frames received=2')
            self.assertFalse(air.buffer)
            valve.downlink.assert_called_once_with(command)
            waiting.result()

    def test_valve_command_after_gui_open_and_before_window_still_fails(self):
        host, model = socket.socketpair()
        valve = Mock(devaddr=1)
        _, command_wire = self.downlink(valve.devaddr)
        vm = Mock()
        vm.command.return_value = (0, '5 0')
        with host, model:
            with self.assertRaisesRegex(RuntimeError, 'valve downlink before receive window'):
                radio_suite.run_valve(vm, radio_suite.Radio(host), {radio_suite.VALVE: valve},
                                      lambda: model.sendall(command_wire))

    def radio_evidence(self, output, code=0, delivered=1):
        vm = Mock()
        vm.command.return_value = (code, output)
        return radio_suite._radio_evidence(vm, radio_suite.Marker('fixture', '5', 0), delivered)

    def test_model_delivery_without_concentratord_frame_fails(self):
        with self.assertRaisesRegex(RuntimeError, 'Concentratord frames received=0'):
            self.radio_evidence('marked\nclosed\nram 0')

    def test_unavailable_concentratord_log_fails(self):
        with self.assertRaisesRegex(RuntimeError, 'persistent log unreadable'):
            self.radio_evidence('match 4 1\nmarked\nclosed', code=1, delivered=4)

    def test_frames_without_crc_filter_do_not_count(self):
        with self.assertRaisesRegex(RuntimeError, 'disable_crc_filter is not false'):
            self.radio_evidence('crc-filter-off')

    def test_unclosed_window_does_not_count(self):
        with self.assertRaisesRegex(RuntimeError, 'end marker did not reach the persistent log within 10 s'):
            self.radio_evidence('match 81 1\nmarked\nram 0')

    def test_positive_model_and_concentratord_counts_pass(self):
        self.assertEqual(self.radio_evidence('match 81 1\nmatch 82 2\nmarked\nclosed\nram 0', delivered=2),
                         'WM1302 model delivered=2, Concentratord frames received=2')

    def test_no_output_or_message_names_crc_ok(self):
        # Concentratord, its HAL wrapper and libconcentratord never log the
        # string "CRC_OK", so a count of it always reads 0.
        self.assertNotIn('CRC_OK', Path(radio_suite.__file__).read_text())

    def test_uplink_case_without_injections_fails(self):
        vm = Mock()
        vm.command.return_value = (0, '4')
        with self.assertRaisesRegex(RuntimeError, 'WM1302 model delivered zero frames'):
            radio_suite.inject(vm, Mock(), {})

    # The join frame's count_us, the model stamp it came from (the HAL
    # subtracts about 460 us at SF7), and the join-accept scheduled 5 s later.
    FRAME = 'match 81 137293609\n'
    STAMP = (137293609 + 460) % (1 << 27) * 32
    ACCEPT = 'dl enqueue 7 142293609 138000000\ndl tx 7 142293609 -\n'
    CLOSED = 'marked\nclosed\nram 1'

    def join_fixture(self, arrivals):
        now = 0
        deadline = None
        air = Mock()
        valve = Mock(devnonce=1, app_eui=bytes(8))
        valve.join_request.side_effect = lambda: bytes([valve.devnonce])
        valve.uplink.return_value = b'data'
        # Attempt n gets DevAddr n and JoinNonce n, as the guest below reports.
        # ChirpStack stores JoinNonce n and sends n - 1 on the wire.
        valve.accept_join.side_effect = lambda reply: {'devaddr': valve.devnonce,
                                                       'appnonce': (valve.devnonce - 1).to_bytes(3, 'little')}
        replies = iter(arrivals)

        def send(frame, channel=radio_suite.UPLINK):
            nonlocal deadline
            self.assertEqual(channel, radio_suite.UPLINK)
            air.last_stamp = self.STAMP
            if frame != b'data':
                delay = next(replies)
                deadline = None if delay is None else now + delay
            return 1

        def receive(timeout, matches):
            nonlocal now, deadline
            if deadline is not None and deadline <= now + timeout:
                now, deadline = deadline, None
                reply = b'\x20'
                self.assertTrue(matches(reply))
                return reply
            now += timeout
            raise TimeoutError

        air.send.side_effect = send
        air.receive.side_effect = receive
        return air, valve, lambda: now

    def guest(self, frames=None, states=None):
        """A guest that answers markers, window reads and ChirpStack reads.

        frames maps an attempt number to the window read's output, and states
        maps (attempt, 'before' or 'after') to the ChirpStack read's output.
        By default attempt n reads a complete window, and ChirpStack moves from
        DevNonces 1..n-1, DevAddr n-1 and JoinNonce n-1 to the same plus n.
        """
        scripts = []
        state_reads = 0

        def command(script, timeout=None):
            nonlocal state_reads
            scripts.append(script)
            attempt = sum('# attempt-marker' in s for s in scripts)
            if '# attempt-marker' in script:
                return 0, '5 0'
            if 'frames()' in script:
                return 0, (frames or {}).get(attempt, self.FRAME + self.ACCEPT + self.CLOSED)
            if 'device_keys' in script:
                state_reads += 1
                attempt, phase = (state_reads + 1) // 2, ('before', 'after')[(state_reads + 1) % 2]
                n = attempt - (phase == 'before')
                default = f'{json.dumps(list(range(1, n + 1)), separators=(",", ":"))} {f"{n:08X}" if n else "-"} {n}'
                return 0, (states or {}).get((attempt, phase), default)
            raise AssertionError('unexpected guest command')

        return SimpleNamespace(command=command), scripts

    def run_join(self, arrivals, **guest):
        air, valve, clock = self.join_fixture(arrivals)
        vm, scripts = self.guest(**guest)
        output = io.StringIO()
        with (patch.object(radio_suite.time, 'monotonic', clock),
              patch.object(radio_suite, '_wait_history'), redirect_stdout(output)):
            result = radio_suite.inject(vm, air, {radio_suite.VALVE: valve})
        return result, output.getvalue(), air, valve, scripts

    def test_join_receipt_needs_frame_chirpstack_and_accept(self):
        result, output, _, valve, scripts = self.run_join([5.0])
        self.assertEqual(result, 'WM1302 model delivered=2, complete join receipts=1 '
                                 '(Concentratord frame, ChirpStack DevNonce, join-accept)')
        self.assertEqual(output.strip(), (
            f'{radio_suite.VALVE} join attempt 1/3 (DevNonce 1, sent 902300000 Hz, 125000 Hz, SF7): received | '
            'frame: Concentratord uplink_id 81 (count_us 137293609) at 902300000 Hz, 125000 Hz, SF7, '
            f'model stamp {self.STAMP}, join-accept scheduled +5 s; '
            'chirpstack: ChirpStack DevNonce 1 new, JoinNonce 0->1, DevAddr unset->00000001; '
            'join-accept: join-accept after 5.00 s'))
        # ChirpStack is read before the marker and after the window closes.
        kinds = ['state' if 'device_keys' in s else 'marker' if '# attempt-marker' in s else
                 'window' if 'frames()' in s else 'other' for s in scripts]
        self.assertEqual(kinds, ['state', 'marker', 'window', 'state'])
        window = scripts[2]
        self.assertIn("-v freq='902300000' -v bw='125000' -v dr='SF7'", window)
        self.assertIn("[ '5' = - ]", window)
        self.assertIn('tail -c +1 ', window)
        self.assertIn(f"k.dev_eui = x'{radio_suite.VALVE}' AND lower(j.key) = '0000000000000000'", scripts[0])
        self.assertIn('-readonly', scripts[0])
        self.assertNotIn('app_key', scripts[0])
        valve.accept_join.assert_called_once()

    def assert_incomplete(self, missing, reason, arrivals=(5.0,), **guest):
        air, valve, clock = self.join_fixture(list(arrivals) + [5.0, 5.0])
        vm, _ = self.guest(**guest)
        output = io.StringIO()
        with (patch.object(radio_suite.time, 'monotonic', clock), redirect_stdout(output),
              patch.object(radio_suite, '_wait_history'),
              self.assertRaisesRegex(RuntimeError, 'incomplete join receipt') as raised):
            radio_suite.inject(vm, air, {radio_suite.VALVE: valve})
        line = output.getvalue().strip()
        self.assertIn(f'attempt 1/3 (DevNonce 1, sent {radio_suite.UPLINK}): missing {missing} |', line)
        self.assertIn(reason, line)
        self.assertIn(line, str(raised.exception))
        # A missing frame or ChirpStack part is never retried.
        self.assertEqual(air.send.call_count, 1)
        valve.uplink.assert_not_called()

    def test_join_without_concentratord_frame_fails(self):
        self.assert_incomplete('frame', 'no Concentratord "Frame received" line in the attempt window '
                                        'of the persistent log (RAM ring has 1)',
                               frames={1: self.ACCEPT + self.CLOSED})

    def test_join_frame_at_another_frequency_or_sf_fails(self):
        for channel in ('902500000 125000 SF7', '902300000 125000 SF8', '902300000 500000 SF7'):
            with self.subTest(channel=channel):
                self.assert_incomplete('frame', f'uplink_id 81 at freq/bw/dr {channel.replace(" ", "/")}, '
                                                'expected 902300000 Hz, 125000 Hz, SF7',
                                       frames={1: f'other 81 {channel}\n' + self.ACCEPT + self.CLOSED})

    def test_unrelated_same_channel_frame_cannot_supply_the_join_frame(self):
        # Only a data frame is retained, with its own reply 1 s later.
        self.assert_incomplete('frame', f'no Concentratord frame carries the model stamp {self.STAMP}',
                               frames={1: 'match 99 200000000\ndl tx 8 201000000 -\n' + self.ACCEPT + self.CLOSED})

    def test_cross_paired_frame_and_join_downlink_fail(self):
        # The join's frame line (count_us 102000000) is lost. An unrelated
        # same-channel frame at 101000000 is kept, and so is the real join's
        # RX1 downlink at 107000000, which is 6 s after the unrelated frame.
        air, valve, clock = self.join_fixture([5.0])
        send = air.send.side_effect

        def send_join(frame, channel=radio_suite.UPLINK):
            delivered = send(frame, channel)
            air.last_stamp = 102000000 * 32 % (1 << 32)
            return delivered

        air.send.side_effect = send_join
        vm, _ = self.guest(frames={1: 'match 99 101000000\ndl enqueue 7 107000000 103000000\n'
                                      'dl tx 7 107000000 -\n' + self.CLOSED})
        output = io.StringIO()
        with (patch.object(radio_suite.time, 'monotonic', clock), redirect_stdout(output),
              self.assertRaisesRegex(RuntimeError, 'incomplete join receipt')):
            radio_suite.inject(vm, air, {radio_suite.VALVE: valve})
        # The real join-accept arrived, so only the frame is missing.
        self.assertIn('missing frame |', output.getvalue())
        self.assertIn('frames at 902300000 Hz, 125000 Hz, SF7: uplink_id 99 (count_us 101000000)', output.getvalue())

    def test_frame_binding_tolerates_only_the_hal_correction(self):
        stamp = 102000000 * 32 % (1 << 32)
        base = stamp // 32
        for delta, bound in ((0, True), (460, True), (20000, True), (20001, False), (-1, False), (1000000, False)):
            with self.subTest(delta=delta):
                self.assertEqual(radio_suite._bound_to_stamp(base - delta, stamp), bound)
        # The HAL adds wrap bits above bit 26 that the stamp does not carry.
        self.assertTrue(radio_suite._bound_to_stamp(base - 460 + 3 * (1 << 27), stamp))
        # A stamp just past a 27-bit wrap binds a count just before it.
        self.assertTrue(radio_suite._bound_to_stamp((1 << 27) - 100 + (5 << 27), 200 * 32))

    def test_receipt_without_a_stamp_fails(self):
        frames = radio_suite.Frames(matched=[('81', 137293609)], marked=True)
        self.assertEqual(radio_suite._join_frame(frames, None)[1], 'the WM1302 model receipt carried no timestamp')

    def test_join_frame_without_attempt_marker_fails(self):
        self.assert_incomplete('frame', 'attempt marker absent from the persistent log',
                               frames={1: self.FRAME + self.ACCEPT + 'unmarked\nram 1'})

    def test_join_window_without_end_marker_fails(self):
        self.assert_incomplete('frame', 'end marker did not reach the persistent log within 10 s',
                               frames={1: self.FRAME + self.ACCEPT + 'marked\nram 1'})

    def test_join_window_rotated_away_fails(self):
        self.assert_incomplete('frame', 'persistent log rotated past the attempt marker',
                               frames={1: 'rotated-away'})

    def test_join_without_new_chirpstack_devnonce_fails(self):
        self.assert_incomplete('chirpstack', 'ChirpStack recorded no DevNonce 1 for A840410000000001 after the send',
                               states={(1, 'after'): '[] 00000001 1'})

    def test_stale_chirpstack_state_fails_where_a_same_second_join_passes(self):
        # No timestamps are compared: state already holding the DevNonce fails
        # even if it was written in the same second as the send.
        self.assert_incomplete('chirpstack', 'ChirpStack already had DevNonce 1 for A840410000000001 before the send',
                               states={(1, 'before'): '[1] 00000001 1', (1, 'after'): '[1] 00000001 1'})
        _, output, *_ = self.run_join([5.0], states={(1, 'before'): '[] - 0', (1, 'after'): '[1] 00000001 1'})
        self.assertIn('received |', output)

    def test_join_nonce_that_did_not_advance_fails(self):
        self.assert_incomplete('chirpstack', 'ChirpStack JoinNonce did not advance by one (before 0, after 0)',
                               states={(1, 'after'): '[1] 00000001 0'})

    def test_unchanged_dev_addr_fails(self):
        self.assert_incomplete('chirpstack', 'ChirpStack DevAddr did not change (before 00000001, after 00000001)',
                               states={(1, 'before'): '[] 00000001 0'})

    def test_join_accept_from_another_join_fails(self):
        self.assert_incomplete('chirpstack', 'ChirpStack DevAddr 01E1EE61 differs from join-accept DevAddr 00000001',
                               states={(1, 'after'): '[1] 01E1EE61 1'})

    def test_join_accept_with_another_join_nonce_fails(self):
        # The wire carries 0 (DevNonce 1 - 1); ChirpStack's pre-send value is 1.
        self.assert_incomplete('chirpstack', "join-accept JoinNonce 0 differs from ChirpStack's pre-send JoinNonce 1",
                               states={(1, 'before'): '[] - 1', (1, 'after'): '[1] 00000001 2'})

    def test_join_accept_carries_the_pre_send_join_nonce(self):
        # ChirpStack 4.12.1 stores 0 -> 1 and puts 0 on the wire.
        before = radio_suite.ChirpStackState((), None, 0)
        after = radio_suite.ChirpStackState((1,), '00000001', 1)
        text, missing = radio_suite._chirpstack_part(before, after, radio_suite.VALVE, 1, ('00000001', 0))
        self.assertIsNone(missing)
        self.assertIn('JoinNonce 0->1', text)
        _, missing = radio_suite._chirpstack_part(before, after, radio_suite.VALVE, 1, ('00000001', 1))
        self.assertIn("join-accept JoinNonce 1 differs from ChirpStack's pre-send JoinNonce 0", missing)

    def test_unreadable_chirpstack_database_fails(self):
        self.assert_incomplete('chirpstack', 'ChirpStack database unreadable', states={(1, 'after'): ''})

    def test_wrapped_join_drains_then_retries_with_fresh_devnonce(self):
        _, output, air, valve, scripts = self.run_join([139.31, 5.1])
        self.assertEqual([call.args[0] for call in air.send.call_args_list], [b'\x01', b'\x02', b'data'])
        self.assertEqual([round(call.args[0], 2) for call in air.receive.call_args_list], [40, 110, 40])
        valve.accept_join.assert_called_once()
        first, second = output.splitlines()
        self.assertIn('(DevNonce 1, sent 902300000 Hz, 125000 Hz, SF7): missing join-accept |', first)
        self.assertIn('join-accept: MISSING (Concentratord scheduled the join-accept for TX (downlink_id 7); '
                      'join-accept late after 139.31 s (drained))', first)
        self.assertIn('attempt 2/3 (DevNonce 2, sent 902300000 Hz, 125000 Hz, SF7): received |', second)
        self.assertIn('ChirpStack DevNonce 2 new, JoinNonce 1->2, DevAddr 00000001->00000002', second)
        self.assertIn('join-accept after 5.10 s', second)

    def test_three_missed_accepts_fail(self):
        air, valve, clock = self.join_fixture([None, None, None])
        vm, _ = self.guest()
        output = io.StringIO()
        with (patch.object(radio_suite.time, 'monotonic', clock), redirect_stdout(output),
              self.assertRaisesRegex(RuntimeError, 'join-accept absent after 3 attempts')):
            radio_suite.inject(vm, air, {radio_suite.VALVE: valve})
        self.assertEqual(clock(), 450)
        self.assertEqual([call.args[0] for call in air.send.call_args_list], [b'\x01', b'\x02', b'\x03'])
        lines = output.getvalue().splitlines()
        self.assertEqual(len(lines), 3)
        for attempt, line in enumerate(lines, 1):
            self.assertIn(f'attempt {attempt}/3 (DevNonce {attempt}, sent {radio_suite.UPLINK}): '
                          'missing join-accept |', line)
            self.assertIn('join-accept absent after 150.00 s)', line)
        valve.accept_join.assert_not_called()

    def test_timed_out_attempt_without_frame_fails_before_a_good_retry(self):
        self.assert_incomplete('frame, join-accept', 'no Concentratord "Frame received" line',
                               arrivals=(None,), frames={1: self.CLOSED})

    def test_timed_out_attempt_with_unreadable_database_fails_before_a_good_retry(self):
        self.assert_incomplete('chirpstack, join-accept', 'ChirpStack database unreadable',
                               arrivals=(None,), states={(1, 'after'): 'garbage'})

    def test_retry_reads_its_own_window(self):
        _, _, _, _, scripts = self.run_join([139.31, 5.1])
        markers = [s for s in scripts if '# attempt-marker' in s]
        windows = [s for s in scripts if 'frames()' in s]
        first, second = [re.search(r'logger -t osi-radio-suite (\w+)', s).group(1) for s in markers]
        self.assertNotEqual(first, second)
        self.assertIn(f"marker='{first}'", windows[0])
        self.assertIn(f"marker='{second}'", windows[1])
        self.assertNotIn(first, windows[1])

    def test_join_accept_dropped_as_too_old_is_named(self):
        # Concentratord queued the join-accept for count_us + 5 s and dropped
        # it 6.5 ms late; ChirpStack had answered.
        _, output, *_ = self.run_join([None, 5.0], frames={1: (
            self.FRAME + 'dl enqueue 7 142293609 138000000\ndl too-old - 142293609 142300075\n' + self.CLOSED)})
        first, second = output.splitlines()
        self.assertIn('missing join-accept | frame: Concentratord uplink_id 81', first)
        self.assertIn('chirpstack: ChirpStack DevNonce 1 new', first)
        self.assertIn('join-accept: MISSING (join-accept dropped by concentratord: too old, 6.5 ms after its TX '
                      'time; join-accept absent after 150.00 s)', first)
        self.assertIn('attempt 2/3', second)
        self.assertIn('received', second)

    def test_drop_attribution_follows_this_joins_schedule(self):
        frames = radio_suite.Frames(downlinks=[
            radio_suite.Downlink('too-old', '-', 999, 1000),                    # another downlink
            radio_suite.Downlink('too-late', '3', 4294967000, 4294966000),      # 1 ms lead before the wrap
            radio_suite.Downlink('too-late', '4', 100, 4294967200),             # lead across the wrap
            radio_suite.Downlink('too-late', '5', 200, 300),                    # already past
            radio_suite.Downlink('too-old', '-', 4294967000, 500),              # dropped across the wrap
        ])
        fate = radio_suite._join_accept_fate
        self.assertIsNone(fate(frames, 12345))
        self.assertEqual(fate(frames, 4294967000), 'join-accept refused by concentratord at enqueue: too late, '
                                                    'only 1.0 ms lead time')
        self.assertEqual(fate(frames, 100), 'join-accept refused by concentratord at enqueue: too late, '
                                             'only 0.2 ms lead time')
        self.assertEqual(fate(frames, 200), 'join-accept refused by concentratord at enqueue: too late, '
                                             '0.1 ms past its TX time')
        frames.downlinks = frames.downlinks[4:]
        self.assertEqual(fate(frames, 4294967000), 'join-accept dropped by concentratord: too old, '
                                                    '0.8 ms after its TX time')

    def test_join_frame_correlation_handles_the_counter_wrap(self):
        frames = radio_suite.Frames(matched=[('81', 4293000000)], marked=True,
                                    downlinks=[radio_suite.Downlink('tx', '7', 4293000000 + 6000000 - (1 << 32), None)])
        text, missing, scheduled = radio_suite._join_frame(frames, (4293000000 + 460) % (1 << 27) * 32)
        self.assertIsNone(missing)
        self.assertEqual(scheduled, 4032704)
        self.assertIn('join-accept scheduled +6 s', text)

    def test_join_sends_and_matches_the_attempt_channel(self):
        channel = radio_suite.Channel(902500000, 125000, 9)
        air, valve, clock = self.join_fixture([5.0])
        air.send.side_effect = lambda frame, sent: self.assertEqual(sent, channel) or 1
        air.last_stamp = self.STAMP
        air.receive.side_effect = lambda timeout, matches: b'\x20'
        vm, scripts = self.guest()
        line = []
        with patch.object(radio_suite.time, 'monotonic', clock):
            radio_suite._join(vm, air, radio_suite.VALVE, valve, line.append, channel)
        self.assertIn('sent 902500000 Hz, 125000 Hz, SF9', line[0])
        query = next(s for s in scripts if 'frames()' in s)
        self.assertIn("-v freq='902500000' -v bw='125000' -v dr='SF9'", query)

    def test_diagnostics_report_persistent_and_ram_counts_separately(self):
        stats = 'Sun Apr 13 16:45:{} 2025 user.info chirpstack-concentratord-sx1302[{}]: Publishing stats event, rx_received: {}, rx_received_ok: {}, tx_received: 0, tx_emitted: 0\n'
        with tempfile.TemporaryDirectory() as directory:
            receipts = Path(directory)
            (receipts/'osi-system.log.old').write_text('Frame received, uplink_id: 81\n' + stats.format('27', 51, 0, 0))
            (receipts/'osi-system.log').write_text(
                'Frame received, uplink_id: 82\n' + stats.format('57', 51, 3, 3) + stats.format('27', 51, 0, 0)
                + stats.format('02', 77, 0, 0))

            def run_uplinks_case(label, fn):
                if label == 'WM1302 uplinks':
                    with self.assertRaisesRegex(RuntimeError, 'fixture radio failure'):
                        fn()

            vm = SimpleNamespace(command=lambda script: self.run_log_script(script, receipts, 'JoinRequest'),
                                 radio=None, receipts=receipts)
            with patch.object(radio_suite, 'run_uplinks', side_effect=RuntimeError('fixture radio failure')):
                acceptance.stock_cases(vm, None, run_uplinks_case)
            diag = (receipts/'radio-diagnostics.log').read_text()
            self.assertIn('Frame received, uplink_id: 2\n', diag)
            self.assertIn('logread\nFrame received, uplink_id: 0\n', diag)
            # The last window of process 51 reads 0 although it received 3 frames.
            self.assertIn('concentratord pid 51 stats windows 3 rx_received total 3 last window 0\n', diag)
            self.assertIn('concentratord pid 77 stats windows 1 rx_received total 0 last window 0\n', diag)
            self.assertNotIn('CRC_OK', diag)
            self.assertNotIn('JoinRequest', diag)
            self.assertIn('Scheduled packet is too old 0\n', diag)
            # One label and one count per line: no doubled "0" from `grep -c ... || echo 0`.
            persistent = diag.split('logread\n')[0].splitlines()[1:]
            for line in persistent:
                if not line.startswith('concentratord pid'):
                    self.assertRegex(line, r'^[^\d\n]+ \d+$')

    # Real guest scripts against log fixtures.
    LINE = 'Sun Apr 13 16:45:08 2025 user.'
    DAEMON = 'chirpstack-concentratord-sx1302[51]: '

    def frame_line(self, uplink, count=137293609, freq=902300000, bw=125000, dr='SF7'):
        return (f'{self.LINE}info {self.DAEMON}Frame received, uplink_id: {uplink}, count_us: {count}, '
                f'freq: {freq}, bw: {bw}, mod: LoRa, dr: {dr}, ftime_received: false, ftime_ns: 0')

    def marker_line(self, marker):
        return f'{self.LINE}notice osi-radio-suite: {marker}'

    def guest_logs(self, root, ram_log='', prelude=''):
        """Run guest scripts against root; logger appends to the active log."""
        def command(script, timeout=None):
            script = script.replace('/var/etc/chirpstack-concentratord/concentratord.toml',
                                    quote(str(root/'concentratord.toml')))
            script = script.replace('/data/log/', quote(str(root)) + '/')
            fixture = (f"logread() {{ printf '%s\\n' {quote(ram_log)}; }}\n"
                       f"logger() {{ printf '%s\\n' \"{self.LINE}notice osi-radio-suite: $3\" "
                       f">> {quote(str(root/'osi-system.log'))}; }}\n"
                       "sleep() { :; }\n" + prelude)
            result = subprocess.run(['sh', '-c', fixture + script], capture_output=True, text=True)
            return result.returncode, result.stdout.strip()
        return SimpleNamespace(command=command)

    def snapshot(self, path, offset=None):
        return radio_suite.Marker('fixture', str(path.stat().st_ino),
                                  path.stat().st_size if offset is None else offset)

    def log_root(self, directory, active, rotated=None):
        root = Path(directory)
        (root/'concentratord.toml').write_text('disable_crc_filter=false\n')
        if rotated is not None:
            (root/'osi-system.log.old').write_text(''.join(line + '\n' for line in rotated))
        (root/'osi-system.log').write_text(''.join(line + '\n' for line in active))
        return root

    def test_marker_snapshots_the_active_log_before_logging(self):
        with tempfile.TemporaryDirectory() as directory:
            root = self.log_root(directory, ['earlier line'])
            size = (root/'osi-system.log').stat().st_size
            marker = radio_suite._mark_attempt(self.guest_logs(root))
            self.assertEqual(marker.inode, str((root/'osi-system.log').stat().st_ino))
            self.assertEqual(marker.offset, size)
            self.assertTrue((root/'osi-system.log').read_text().endswith(f'osi-radio-suite: {marker.id}\n'))
            (root/'osi-system.log').unlink()
            self.assertEqual(radio_suite._mark_attempt(self.guest_logs(root)).inode, '-')

    def test_window_reads_the_frame_and_join_downlinks_from_the_snapshot(self):
        lines = [self.frame_line(80), self.marker_line('fixture'), self.frame_line(81),
                 self.frame_line(82, freq=902500000), self.frame_line(83, dr='SF8'), self.frame_line(81),
                 f'{self.LINE}info {self.DAEMON}Enqueueing timestamped packet, downlink_id: 7, counter_us: 142293609, '
                 'current_counter_us: 138000000',
                 f'{self.LINE}info {self.DAEMON}Scheduled packet for TX, downlink_id: 7, count_us: 142293609, '
                 'freq: 923300000, bw: 500000, mod: LoRa, dr: SF7',
                 f'{self.LINE}info unrelated[42]: printed {self.DAEMON}Frame received, uplink_id: 84, count_us: 1, '
                 'freq: 902300000, bw: 125000, mod: LoRa, dr: SF7']
        with tempfile.TemporaryDirectory() as directory:
            root = self.log_root(directory, lines)
            frames = radio_suite._concentratord_frames(self.guest_logs(root), self.snapshot(root/'osi-system.log', 0))
        self.assertEqual(frames.error, '')
        self.assertTrue(frames.marked)
        self.assertEqual(frames.matched, [('81', 137293609)])
        self.assertEqual(frames.other, [('82', '902500000', '125000', 'SF7'), ('83', '902300000', '125000', 'SF8')])
        self.assertEqual(frames.downlinks, [radio_suite.Downlink('enqueue', '7', 142293609, 138000000),
                                            radio_suite.Downlink('tx', '7', 142293609, None)])
        text, missing, scheduled = radio_suite._join_frame(frames, self.STAMP)
        self.assertEqual((missing, scheduled), (None, 142293609))

    def test_window_starts_at_the_snapshot_offset(self):
        # A matching frame before the snapshot offset is outside the window,
        # even if a stale marker with the same name precedes it.
        old = [self.marker_line('fixture'), self.frame_line(80)]
        with tempfile.TemporaryDirectory() as directory:
            root = self.log_root(directory, old)
            marker = self.snapshot(root/'osi-system.log')
            with (root/'osi-system.log').open('a') as log:
                log.write(self.marker_line('fixture') + '\n')
            frames = radio_suite._concentratord_frames(self.guest_logs(root), marker)
        self.assertTrue(frames.marked)
        self.assertEqual(frames.matched, [])

    def test_marker_and_frame_split_across_a_rotation(self):
        with tempfile.TemporaryDirectory() as directory:
            root = self.log_root(directory, [self.frame_line(81)], rotated=['old line', self.marker_line('fixture')])
            rotated = root/'osi-system.log.old'
            marker = radio_suite.Marker('fixture', str(rotated.stat().st_ino), len('old line\n'))
            frames = radio_suite._concentratord_frames(self.guest_logs(root), marker)
        self.assertEqual((frames.error, frames.marked, frames.matched), ('', True, [('81', 137293609)]))

    def test_rotation_during_the_read_repeats_it(self):
        # logd rotates the active file during the first read and writes the
        # end marker into the new file. That read sees the end marker but not
        # the attempt marker or frame; only a repeated read finds them.
        with tempfile.TemporaryDirectory() as directory:
            root = self.log_root(directory, [self.marker_line('fixture'), self.frame_line(81)])
            active, rotated = root/'osi-system.log', root/'osi-system.log.old'
            marker = self.snapshot(active, 0)
            flag = root/'rotated'
            prelude = ('logger() { :; }\n'
                       f'tail() {{ if [ ! -e {quote(str(flag))} ]; then : > {quote(str(flag))}; '
                       f'mv {quote(str(active))} {quote(str(rotated))}; '
                       f"printf '%s\\n' {quote(self.marker_line('fixture-end'))} > {quote(str(active))}; fi; "
                       'command tail "$@"; }\n')
            frames = radio_suite._concentratord_frames(self.guest_logs(root, prelude=prelude), marker)
            self.assertTrue(flag.exists())
        self.assertEqual((frames.error, frames.marked, frames.matched), ('', True, [('81', 137293609)]))

    def test_rotation_after_the_old_inode_lookup_repeats_the_read(self):
        # logd rotates just after the scan looked up the old file's inode, so
        # the scan sees neither file with the tracked inode. The end marker
        # lands in the new active file. A changed layout must repeat the read
        # instead of reporting the evidence as rotated away.
        with tempfile.TemporaryDirectory() as directory:
            root = self.log_root(directory, [self.marker_line('fixture'), self.frame_line(81)],
                                 rotated=['older file'])
            active, rotated, count = root/'osi-system.log', root/'osi-system.log.old', root/'old-lookups'
            marker = self.snapshot(active, 0)
            prelude = ('logger() { :; }\n'
                       'ls() { command ls "$@"; case "$2" in *.old) '
                       f'n=$(cat {quote(str(count))} 2>/dev/null || echo 0); n=$((n + 1)); echo "$n" > {quote(str(count))}; '
                       f'if [ "$n" = 2 ]; then mv {quote(str(active))} {quote(str(rotated))}; '
                       f"printf '%s\\n' {quote(self.marker_line('fixture-end'))} > {quote(str(active))}; fi;; esac; }}\n")
            frames = radio_suite._concentratord_frames(self.guest_logs(root, prelude=prelude), marker)
            self.assertGreaterEqual(int(count.read_text()), 2)
        self.assertEqual((frames.error, frames.marked, frames.matched), ('', True, [('81', 137293609)]))

    def test_failed_file_read_is_not_parsed(self):
        # tail prints a complete-looking window and then fails.
        with tempfile.TemporaryDirectory() as directory:
            root = self.log_root(directory, [self.marker_line('fixture')])
            window = [self.marker_line('fixture'), self.frame_line(81), self.marker_line('fixture-end')]
            prelude = f"tail() {{ printf '%s\\n' {' '.join(quote(line) for line in window)}; return 1; }}\n"
            frames = radio_suite._concentratord_frames(self.guest_logs(root, prelude=prelude),
                                                       self.snapshot(root/'osi-system.log', 0))
        self.assertEqual((frames.error, frames.matched), ('persistent log read failed', []))

    def test_window_rotated_away_is_reported(self):
        with tempfile.TemporaryDirectory() as directory:
            root = self.log_root(directory, [self.marker_line('fixture'), self.frame_line(81)])
            marker = radio_suite.Marker('fixture', '1', 0)   # no file has this inode any more
            frames = radio_suite._concentratord_frames(self.guest_logs(root), marker)
        self.assertIn('rotated past the attempt marker', frames.error)

    def test_window_closes_at_the_end_marker_and_the_next_marker(self):
        too_old = (f'{self.LINE}err {self.DAEMON}Scheduled packet is too old, dropped: count_us: 142293609, '
                   'current_counter_us: 142300075')
        too_late = (f'{self.LINE}warn {self.DAEMON}Too late to enqueue packet, downlink_id: 9, counter_us: 5, '
                    'current_counter_us: 9')
        with tempfile.TemporaryDirectory() as directory:
            root = self.log_root(directory, [self.marker_line('fixture'), self.frame_line(81), too_old,
                                             self.marker_line('next'), self.frame_line(82), too_late])
            vm = self.guest_logs(root)
            first = radio_suite._concentratord_frames(vm, self.snapshot(root/'osi-system.log', 0))
            # Lines after the end marker the read wrote are outside the window.
            with (root/'osi-system.log').open('a') as log:
                log.write(self.frame_line(85) + '\n')
            second = radio_suite._concentratord_frames(vm, radio_suite.Marker('next', first and str(
                (root/'osi-system.log').stat().st_ino), 0))
        self.assertEqual((first.matched, first.downlinks),
                         ([('81', 137293609)], [radio_suite.Downlink('too-old', '-', 142293609, 142300075)]))
        self.assertEqual((second.matched, second.downlinks),
                         ([('82', 137293609)], [radio_suite.Downlink('too-late', '9', 5, 9)]))

    def test_window_without_end_marker_is_not_closed(self):
        with tempfile.TemporaryDirectory() as directory:
            root = self.log_root(directory, [self.marker_line('fixture'), self.frame_line(81)])
            # logd never writes the end marker to the file.
            vm = self.guest_logs(root, prelude='logger() { :; }\n')
            frames = radio_suite._concentratord_frames(vm, self.snapshot(root/'osi-system.log', 0))
        self.assertEqual(frames.error, 'end marker did not reach the persistent log within 10 s')

    def test_window_reads_only_the_persistent_log(self):
        first, second = self.frame_line(81), self.frame_line(82)
        marker = self.marker_line('fixture')
        cases = (
            ('persistent log lags', [marker], [marker, first], [], 1),
            ('sinks overlap', [marker, first], [marker, first, second], [('81', 137293609)], 2),
            ('RAM has no attempt marker', [marker], [first], [], 0),
        )
        with tempfile.TemporaryDirectory() as directory:
            for name, persistent, ram, matched, ram_matched in cases:
                with self.subTest(name=name):
                    root = self.log_root(directory, persistent)
                    vm = self.guest_logs(root, ram_log='\n'.join(ram))
                    frames = radio_suite._concentratord_frames(vm, self.snapshot(root/'osi-system.log', 0))
                    self.assertEqual(frames.matched, matched)
                    self.assertEqual(frames.ram_matched, ram_matched)

    def test_window_requires_legacy_timestamps(self):
        settings = (
            ('section absent', '', ''),
            ('enable = false', '[gateway.fine_timestamp]\nenable = false\nsource = "ALL"\n', ''),
            ('enable elsewhere', '[gateway.other]\nenable = true\n[gateway.fine_timestamp]\nenable=false\n', ''),
            ('enable = true', '[gateway.fine_timestamp]\nenable = true\nsource = "ALL"\n', 'fine timestamps are enabled'),
            ('enable=true, comment', '[gateway]\n[ gateway.fine_timestamp ]\n  enable=true # PPS\n',
             'fine timestamps are enabled'),
        )
        with tempfile.TemporaryDirectory() as directory:
            for name, toml, error in settings:
                with self.subTest(name=name):
                    root = self.log_root(directory, [self.marker_line('fixture'), self.frame_line(81)])
                    (root/'concentratord.toml').write_text('disable_crc_filter = false\n' + toml)
                    frames = radio_suite._concentratord_frames(self.guest_logs(root),
                                                               self.snapshot(root/'osi-system.log', 0))
                    if error:
                        self.assertIn(error, frames.error)
                        self.assertEqual(frames.matched, [])
                    else:
                        self.assertEqual((frames.error, frames.matched), ('', [('81', 137293609)]))

    def test_window_requires_the_crc_filter(self):
        with tempfile.TemporaryDirectory() as directory:
            root = self.log_root(directory, [])
            (root/'concentratord.toml').write_text('disable_crc_filter=true\n')
            frames = radio_suite._concentratord_frames(self.guest_logs(root), self.snapshot(root/'osi-system.log'))
        self.assertIn('disable_crc_filter is not false', frames.error)

    @unittest.skipUnless(shutil.which('sqlite3'), 'sqlite3 CLI absent')
    def test_chirpstack_query_reads_nonces_devaddr_and_join_nonce(self):
        # Table shapes and the dev_nonces JSON follow ChirpStack 4.12.1's SQLite schema.
        with tempfile.TemporaryDirectory() as directory:
            database = Path(directory)/'chirpstack.sqlite'
            with closing(sqlite3.connect(database)) as db:
                db.executescript("""
CREATE TABLE device (dev_eui blob not null primary key, dev_addr blob, join_eui blob not null);
CREATE TABLE device_keys (dev_eui blob not null primary key, updated_at datetime not null, nwk_key blob not null,
                          app_key blob not null, dev_nonces text not null, join_nonce int not null);
INSERT INTO device VALUES (x'A840410000000001', x'0037032B', x'0000000000000000');
INSERT INTO device VALUES (x'A840410000000002', NULL, x'0000000000000000');
INSERT INTO device_keys VALUES (x'A840410000000001', '2025-04-13 16:47:42.790123456+00:00', x'00', x'00',
                                '{"0000000000000000":[1,2]}', 2);
INSERT INTO device_keys VALUES (x'A840410000000002', '2025-04-13 16:47:51.17+00:00', x'00', x'00',
                                '{"0102030405060708":[1]}', 0);
""")

            def command(script, timeout=None):
                script = script.replace(radio_suite.CHIRPSTACK_DB, quote(str(database)))
                result = subprocess.run(['sh', '-c', script], capture_output=True, text=True)
                return result.returncode, result.stdout.strip()

            vm = SimpleNamespace(command=command)
            join = bytes(8).hex()
            state = radio_suite.ChirpStackState
            self.assertEqual(radio_suite._chirpstack_state(vm, 'A840410000000001', join), state((1, 2), '0037032B', 2))
            self.assertEqual(radio_suite._chirpstack_state(vm, 'A840410000000002', join), state((), None, 0))
            self.assertEqual(radio_suite._chirpstack_state(vm, 'A840410000000003', join), state((), None, None))
            database.unlink()
            self.assertEqual(radio_suite._chirpstack_state(vm, 'A840410000000001', join),
                             state(error='ChirpStack database unreadable'))


class BundleNameTests(unittest.TestCase):
    def test_upgrade_bundle_is_named_after_the_candidate_revision(self):
        # A suite copy once hard-coded BUNDLE_SHA, which mislabelled the bundle
        # when another image was tested. The name must follow --release-revision,
        # which acceptance.py checks against the release tree's SERVED-FROM.txt.
        seen = []

        def deploy_bundle(command, env, **_):
            seen.append(env['BUNDLE_SHA'])
            raise RuntimeError('stop after the bundle script')

        with (tempfile.TemporaryDirectory() as directory,
              patch.object(upgrade_suite.subprocess, 'run', side_effect=deploy_bundle)):
            for revision in ('904491b1' + 'c' * 32, '234a3635' + 'd' * 32):
                folder = Path(directory)/revision
                folder.mkdir()
                with self.assertRaisesRegex(RuntimeError, 'stop after the bundle script'):
                    upgrade_suite.build_media(Path(directory), folder, revision=revision)
        self.assertEqual(seen, ['904491b1', '234a3635'])
        self.assertNotIn('BUNDLE_SHA', Path(upgrade_suite.__file__).read_text().replace("BUNDLE_SHA=revision[:8]", ''))


class FlowTests(unittest.TestCase):
    def test_restart_wait_covers_factory_first_boot(self):
        def command(script, timeout):
            self.assertEqual(timeout, 420)
            # With fast curls and two seconds between polls, the 124th
            # poll represents the measured 246 s console-to-401 delay.
            fixture = """polls=0
curl() { [ "$polls" -ge 123 ] && printf 401; }
sleep() { [ "$1" = 2 ] || exit 2; polls=$((polls + 1)); }
"""
            result = subprocess.run(['sh', '-c', fixture + script], capture_output=True, text=True)
            return result.returncode, result.stdout.strip()

        upgrade_suite.wait_for_api(SimpleNamespace(command=command))

    def test_candidate_gate_fails_when_pi5_workload_omits_a_required_case(self):
        with tempfile.TemporaryDirectory() as directory:
            root = Path(directory)
            revision = 'a' * 40
            (root/'SERVED-FROM.txt').write_text(revision)
            init = root/'feeds/chirpstack-openwrt-feed/apps/node-red/files/node-red.init'
            init.parent.mkdir(parents=True)
            init.write_text(PINNED_CAPABILITY + '\n')
            image = root/'rpi5.img.gz'
            image.write_bytes(b'factory')
            digest = hashlib.sha256(image.read_bytes()).hexdigest()
            for version in ('0.8.0', '0.8.1'):
                folder = root/f'v{version}'
                folder.mkdir()
                (folder/image.name).write_bytes(image.read_bytes())
                (folder/'SHA256SUMS').write_text(f'{digest}  {image.name}\n')

            def stock(_guest, _args, record, *, log, **_options):
                log('fixture radio attempt evidence')
                for label in ('Cold boot', 'First account and login', 'WM1302 uplinks',
                              'Valve open and outcome', 'Reboot persistence', 'Power cut 1', 'Power cut 3'):
                    record(label, lambda: None)

            def stage(source, checksum, destination, *, label):
                result = verified_archive(source, checksum, destination, label=label)
                if source == image:
                    replacement = root/'replacement.img.gz'
                    replacement.write_bytes(b'replacement archive')
                    replacement.replace(image)
                return result

            guest = Mock()

            def open_guest(_work, archive, *_args, **_options):
                self.assertNotEqual(archive, image)
                self.assertEqual(archive.read_bytes(), b'factory')
                return guest

            with (redirect_stdout(io.StringIO()), patch.object(acceptance, 'Guest', side_effect=open_guest),
                  patch.object(acceptance, 'verified_archive', side_effect=stage),
                  patch.dict(os.environ, {'OSI_FLOWS_CAPABILITY': 'minimal'}),
                  patch.object(acceptance, 'checked', return_value=PINNED_CAPABILITY) as checked,
                  patch.object(acceptance, 'stock_cases', side_effect=stock),
                  patch.object(acceptance, 'ready'), patch.object(acceptance, 'build_media'),
                  patch.object(acceptance, 'upgrade'), patch.object(acceptance, 'verify_zero_recovery'),
                  patch.object(acceptance, 'verify_missing_pristine_hold'),
                  patch.object(acceptance, 'cut_after_flows_patch')):
                status = acceptance.main([
                    '--candidate', str(image), '--candidate-sha256', digest,
                    '--osi-version', '0.8.3', '--chirpstack-version', '4.12.1',
                    '--release', str(root), '--release-revision', revision,
                    '--fixtures', str(root), '--run-root', str(root),
                    '--openwrt-host-tools', str(root),
                ])
            checked.assert_called_once_with(guest, 'cat /rom/etc/init.d/node-red')
            result_file = next(root.glob('pi5-acceptance-*/results.log'))
            result = result_file.read_text()
            revision = acceptance.tools_checkout_revision(None)
            self.assertIn(f'Tools revision: {revision}', result)
            self.assertIn('fixture radio attempt evidence', result)
            self.assertIn(f'tools_revision={revision}', result_file.with_name('inputs.txt').read_text())
            self.assertEqual(status, 1, result)
            self.assertIn('Power cut 2 | REQUIRED | NOT RUN | FAIL', result)
            self.assertIn('Case totals: 17 passed / 18 required', result)
            for label in acceptance.FLOWS_CASES + acceptance.BOOT_SAFETY_CASES:
                self.assertIn(f'{label} | REQUIRED | PASS | PASS', result)
            for label in acceptance.MINIMAL_CASES:
                self.assertIn(f'{label} | N/A | NOT RUN | N/A | persistFlowHold present in factory image init'
                              f' | {", ".join(acceptance.RECOVERY_CASES)}', result)

    def test_sqlite_cut_checks_the_clone_before_starting_normally(self):
        vm = Mock()
        vm.inspect_cut.side_effect = lambda inspect: inspect(vm)
        with (patch.object(acceptance, 'snapshot', return_value='synthetic'),
              patch.object(acceptance, 'checked'),
              patch.object(acceptance, 'sql', side_effect=['', 'ok', '1\n1'])):
            with self.assertRaisesRegex(RuntimeError, 'disk before startup:.*transaction mismatch'):
                acceptance.cut(vm, 1, inspect_disk=True)
        vm.stop.assert_called_once_with(cut=True)
        vm.start.assert_not_called()

    def test_pi5_sqlite_cut_reboots_the_original_disk_directly(self):
        vm = Mock()
        with (patch.object(acceptance, 'snapshot', return_value='synthetic'),
              patch.object(acceptance, 'checked'),
              patch.object(acceptance, 'ready') as ready,
              patch.object(acceptance, 'sql', side_effect=['', '1\n0'])):
            acceptance.cut(vm, 1)
        vm.stop.assert_called_once_with(cut=True)
        vm.start.assert_called_once_with()
        vm.inspect_cut.assert_not_called()
        ready.assert_called_once_with(vm)

    def test_current_source_and_guest_receipt(self):
        source = PINNED_CAPABILITY
        if fixture := os.environ.get('OSI_RASPI5_TEST_FLOWS_INIT'):
            source = Path(fixture).read_text()
            self.assertIn("committed flows.json digest=' + digest + ' stamp='", source)
        self.assertTrue(acceptance.has_flows_recovery(source))
        self.assertTrue(acceptance.has_flows_recovery(PINNED_CAPABILITY + '\nwrong receipt wording'))
        self.assertFalse(acceptance.has_flows_recovery('node-red.init: committed flows.json MQTT runtime settings'))
        self.assertEqual(re.search(FLOWS_COMMITTED, COMMIT).group('digest', 'stamp'), (DIGEST, b'20261120T000000Z'))
        self.assertIsNone(re.search(FLOWS_COMMITTED, COMMIT.replace(DIGEST, b'X')))
        self.assertIsNone(re.search(FLOWS_COMMITTED, COMMIT.replace(b' stamp=', b' payload=')))

    def test_offline_capability_cannot_waive_factory_recovery_cases(self):
        with tempfile.TemporaryDirectory() as directory:
            root = Path(directory)
            args = SimpleNamespace(candidate=None, qemu=None, ram=8,
                                   flows_power_cut_only=False, customer_fixture_only=False,
                                   upgrade_boot_safety_only=False)
            with (redirect_stdout(io.StringIO()), patch.object(acceptance, 'Guest') as guest,
                  patch.object(acceptance, 'checked', return_value=PINNED_CAPABILITY) as checked,
                  patch.object(acceptance, 'stock_cases') as stock):
                self.assertEqual(acceptance.run_cases(args, root, root, root, 'minimal', False), 1)
            checked.assert_called_once_with(guest.return_value, 'cat /rom/etc/init.d/node-red')
            stock.assert_not_called()
            result = (root/'results.log').read_text()
            self.assertIn('Factory image and offline tree disagree', result)
            for label in acceptance.RECOVERY_CASES:
                self.assertIn(f'{label} | REQUIRED | NOT RUN | FAIL', result)
            self.assertIn('Case totals: 0 passed / 18 required', result)

    def test_failed_factory_probe_has_no_na_rows(self):
        with tempfile.TemporaryDirectory() as directory:
            root = Path(directory)
            args = SimpleNamespace(candidate=None, qemu=None, ram=8,
                                   flows_power_cut_only=False, customer_fixture_only=False,
                                   upgrade_boot_safety_only=False)
            with (redirect_stdout(io.StringIO()), patch.object(acceptance, 'Guest'),
                  patch.object(acceptance, 'checked', side_effect=RuntimeError('no factory marker'))):
                self.assertEqual(acceptance.run_cases(args, root, root, root, 'minimal', False), 1)
            result = (root/'results.log').read_text()
            self.assertNotIn(' | N/A | ', result)
            self.assertIn('Case totals: 0 passed / 21 required', result)

    def test_first_boot_rejects_deployed_stamp(self):
        vm = Mock()
        vm.start.return_value = (DIGEST, b'deployed')
        with self.assertRaisesRegex(RuntimeError, 'unexpected payload stamp'):
            acceptance.cut_after_flows_patch(vm, True)
        vm.stop.assert_called_once_with(cut=True)

    def test_first_boot_never_restarts_original_after_an_uncommitted_disk(self):
        vm = Mock()
        vm.start.return_value = (DIGEST, b'image')
        vm.verify_cut_disk.side_effect = RuntimeError('disk differs before recovery')
        with self.assertRaisesRegex(RuntimeError, 'differs before recovery'):
            acceptance.cut_after_flows_patch(vm, True)
        vm.start.assert_called_once_with(before_console=FLOWS_COMMITTED)
        vm.verify_cut_disk.assert_called_once_with('factory', (DIGEST, b'image'))

    def test_later_boot_checks_clone_before_normal_recovery(self):
        vm = Mock()
        vm.flows_receipt.return_value = (b'b'*64, b'image')
        vm.command.return_value = (0, '')
        vm.upgrade_reboot.return_value = (DIGEST, b'image')
        vm.verify_cut_disk.side_effect = RuntimeError('disk differs before recovery')
        with self.assertRaisesRegex(RuntimeError, 'differs before recovery'):
            acceptance.cut_after_flows_patch(vm, False)
        vm.start.assert_not_called()
        vm.verify_cut_disk.assert_called_once_with('later boot', (DIGEST, b'image'))

    def test_clone_detects_bytes_that_normal_startup_could_restore(self):
        with tempfile.TemporaryDirectory() as directory:
            vm = Guest.__new__(Guest)
            vm.work = vm.receipts = Path(directory)
            vm.process = vm.bridge = vm.radio = None
            vm.direct_io = True
            (vm.work/'sd.img').write_bytes(b'live disk')

            def boot(*, inspection):
                self.assertTrue(inspection)
                clone = vm.work/'inspect.img'
                self.assertEqual(clone.read_bytes(), b'live disk')
                clone.write_bytes(b'journal replay on clone')

            with (patch.object(vm, 'start', side_effect=boot),
                  patch.object(vm, 'flows_receipt', return_value=(b'b'*64, b'image')),
                  patch.object(vm, 'stop') as stop):
                with self.assertRaisesRegex(RuntimeError, 'differs before recovery'):
                    vm.verify_cut_disk('factory', (DIGEST, b'image'))
                stop.assert_called_once_with(cut=True)
            self.assertEqual((vm.work/'sd.img').read_bytes(), b'live disk')
            self.assertFalse((vm.work/'inspect.img').exists())
            self.assertIn('factory disk ' + 'b'*64, (vm.receipts/'flows-cut.log').read_text())

    def test_inspection_command_attaches_only_the_clone_and_uses_direct_io(self):
        with tempfile.TemporaryDirectory() as directory:
            vm = Guest.__new__(Guest)
            vm.work = Path(directory)
            vm.qemu = vm.work/'qemu'
            vm.process = vm.bridge = None
            vm.boots = 0
            vm.port = 49152
            vm.ram = 8
            vm.private = True
            vm.upgrade = vm.work/'update-usb.img'
            vm.direct_io = True
            (vm.work/'cmdline.txt').write_text('root=/dev/mmcblk0p2')
            report = re.search(rb'(READY|FAILED)', b'READY')
            def verify_launch(args, **options):
                if '-chardev' in args:
                    radio_fd = options['pass_fds'][1]
                    self.assertIn(f'socket,id=wm1302-air,fd={radio_fd},server=off', args)
                    with socket.socket(fileno=os.dup(radio_fd)) as peer:
                        peer.sendall(b'from this boot')
                return Mock()

            with (patch('suite_vm.subprocess.Popen', side_effect=verify_launch) as launch,
                  patch.object(vm, 'expect', return_value=report),
                  patch.object(vm, 'send')):
                vm.start(inspection=True)
                with vm.radio as host:
                    self.assertEqual(host.recv(32), b'from this boot')
            command = launch.call_args.args[0]
            self.assertIn('if=sd,format=raw,file=inspect.img,cache=none', command)
            self.assertIn('init=/bin/sh', command[command.index('-append')+1])
            self.assertNotIn('usb-storage,drive=update', command)

    def test_commit_rejects_different_recovered_bytes_or_stamp(self):
        with tempfile.TemporaryDirectory() as directory:
            vm = Guest.__new__(Guest)
            vm.receipts = Path(directory)
            for wrong in [(b'b'*64, b'image'), (DIGEST, b'other')]:
                with patch.object(vm, 'flows_receipt', return_value=wrong):
                    with self.assertRaisesRegex(RuntimeError, 'differs from commit'):
                        vm.verify_flows_receipt((DIGEST, b'image'))

    def test_upgrade_ending_without_marker_is_red(self):
        vm = Mock()
        vm.flows_receipt.return_value = (DIGEST, b'image')
        vm.command.return_value = (0, '')
        with (patch.object(upgrade_suite, 'checked', side_effect=['0.8.1', 'synthetic']),
              patch.object(upgrade_suite, 'sql', side_effect=['', 'a\nb\nc\nd']),
              patch.object(upgrade_suite, 'wait_for_login'),
              patch('radio_suite._api', return_value={'token': 'synthetic'})):
            with self.assertRaisesRegex(RuntimeError, 'without a flows commit marker'):
                upgrade_suite.run(vm, '0.8.1', '0.8.3', cut_at=FLOWS_COMMITTED)

    def test_upgrade_mismatch_in_clone_prevents_recovery_start(self):
        vm = Mock()
        vm.flows_receipt.return_value = (DIGEST, b'image')
        vm.command.return_value = (None, (DIGEST, b'candidate'))
        vm.verify_cut_disk.side_effect = RuntimeError('disk differs before recovery')
        with (patch.object(upgrade_suite, 'checked', side_effect=['0.8.1', 'synthetic']),
              patch.object(upgrade_suite, 'sql', side_effect=['', 'a\nb\nc\nd']),
              patch.object(upgrade_suite, 'wait_for_login'),
              patch('radio_suite._api', return_value={'token': 'synthetic'})):
            with self.assertRaisesRegex(RuntimeError, 'differs before recovery'):
                upgrade_suite.run(vm, '0.8.1', '0.8.3', cut_at=FLOWS_COMMITTED)
        vm.start.assert_not_called()
        vm.verify_cut_disk.assert_called_once_with('upgrade commit', (DIGEST, b'candidate'))

    def test_applicable_suite_cannot_pass_when_serial_marker_is_absent(self):
        with tempfile.TemporaryDirectory() as directory:
            root = Path(directory)
            fixtures = root/'fixtures'
            folder = fixtures/'v0.8.1'
            folder.mkdir(parents=True)
            image = folder/'rpi5.img.gz'
            image.write_bytes(b'fixture')
            (folder/'SHA256SUMS').write_text(hashlib.sha256(b'fixture').hexdigest() + '  rpi5.img.gz\n')
            args = SimpleNamespace(fixtures=fixtures, candidate=image, qemu=None, ram=8,
                                   candidate_sha256=hashlib.sha256(b'fixture').hexdigest(),
                                   release_revision='a'*40, osi_version='0.8.3',
                                   flows_power_cut_only=True, customer_fixture_only=False,
                                   upgrade_boot_safety_only=False)
            with (redirect_stdout(io.StringIO()), patch.object(acceptance, 'Guest'),
                  patch.object(acceptance, 'build_media'), patch.object(acceptance, 'ready'),
                  patch.object(acceptance, 'cut_after_flows_patch', side_effect=TimeoutError('missing receipt')),
                  patch.object(acceptance, 'upgrade', side_effect=RuntimeError('missing receipt'))):
                self.assertEqual(acceptance.run_cases(args, root, root, root, 'recovery', False), 1)
            result = (root/'results.log').read_text()
            for label in acceptance.FLOWS_CASES:
                self.assertRegex(result, re.escape(label) + r'\s+FAIL')
            self.assertIn('Focused acceptance: FAIL', result)

    def test_minimal_candidate_requires_all_bound_cuts(self):
        for fault in ('none', 'writer', 'flows', 'clone'):
            with self.subTest(fault=fault), tempfile.TemporaryDirectory() as directory:
                root = Path(directory)
                init = root/minimal_flows.INIT
                init.parent.mkdir(parents=True)
                init.write_text(minimal_flows.ATOMIC_PUBLISH + '\n')
                image = root/'candidate.img.gz'
                image.write_bytes(b'factory archive bytes')
                for version in acceptance.UPGRADE_VERSIONS:
                    folder = root/f'v{version}'
                    folder.mkdir()
                    (folder/'rpi5.img.gz').write_bytes(b'fixture')
                    (folder/'SHA256SUMS').write_text(hashlib.sha256(b'fixture').hexdigest() + '  rpi5.img.gz\n')
                args = SimpleNamespace(candidate=image, qemu=None, ram=8, fixtures=root,
                                       flows_power_cut_only=False, customer_fixture_only=False,
                                       upgrade_boot_safety_only=False, release_revision='a'*40,
                                       osi_version='0.8.3', candidate_sha256=hashlib.sha256(image.read_bytes()).hexdigest(),
                                       openwrt_host_tools=root)

                def stock(_guest, _args, record, **_options):
                    for label in acceptance.BASE_CASES[:-2]:
                        record(label, lambda: None)

                def digest_receipt(payload):
                    return '\n'.join((f'{payload.init}  {acceptance.ROM_INIT}',
                                      f'{payload.writer}  {acceptance.ROM_WRITER}',
                                      f'{payload.flows}  {acceptance.ROM_FLOWS}'))

                candidate = acceptance.FactoryPayload(hashlib.sha256(init.read_bytes()).hexdigest(),
                                                       'b'*64, 'c'*64)
                probe_payload = replace(candidate, init='d'*64)
                if fault in ('writer', 'flows'):
                    probe_payload = replace(probe_payload, **{fault: 'e'*64})
                checked = [minimal_flows.ATOMIC_PUBLISH, digest_receipt(candidate),
                           digest_receipt(probe_payload), digest_receipt(probe_payload)]
                def derive(archive, _release, _probe, output, _tools):
                    self.assertNotEqual(archive, image)
                    self.assertEqual(hashlib.sha256(archive.read_bytes()).hexdigest(), args.candidate_sha256)
                    output.write_bytes(b'derived from ' + archive.read_bytes())
                    return hashlib.sha256(output.read_bytes()).hexdigest()

                guest = Mock()
                with (redirect_stdout(io.StringIO()), patch.object(acceptance, 'Guest', guest),
                      patch.object(acceptance, 'derive_probe_image', side_effect=derive) as derive_image,
                      patch.object(acceptance, 'prepare_probe_release', return_value='d'*64),
                      patch.object(acceptance, 'checked', side_effect=checked),
                      patch.object(acceptance, 'wait_for_api') as api,
                      patch.object(acceptance, 'stock_cases', side_effect=stock),
                      patch.object(acceptance, 'ready') as ready, patch.object(acceptance, 'verify_disk') as disk,
                      patch.object(acceptance, 'build_media'), patch.object(acceptance, 'upgrade') as upgrade):
                    if fault == 'clone':
                        disk.side_effect = RuntimeError('clone failed')
                    self.assertEqual(acceptance.run_cases(args, root, root, root, 'minimal', False),
                                     int(fault != 'none'))
                derive_image.assert_called_once()
                # Stock 0.8.0 upgrade keeps the default wait; both 0.8.1 boots get the slow-boot budget.
                vm = guest.return_value
                self.assertEqual(ready.call_args_list, [unittest.mock.call(vm),
                                                        unittest.mock.call(vm, budget=SLOW_BOOT_SECONDS),
                                                        unittest.mock.call(vm, budget=SLOW_BOOT_SECONDS)])
                self.assertEqual(guest.call_args_list[0].args[1], derive_image.call_args.args[0])
                self.assertEqual(sum(call.args[1] == derive_image.call_args.args[3]
                                     for call in guest.call_args_list), 2)
                self.assertEqual([call.kwargs['phase'] for call in disk.call_args_list],
                                 ['committed', 'before-dir-sync'])
                self.assertTrue(all(call.kwargs['shipped_old'] == candidate.flows.encode()
                                    for call in disk.call_args_list))
                self.assertEqual(upgrade.call_args.kwargs['cut_at'], minimal_flows.CUT_RECEIPT)
                self.assertEqual(api.call_count, 2 if fault == 'none' else 0)
                result = (root/'results.log').read_text()
                for label in acceptance.RECOVERY_CASES:
                    self.assertIn(f'{label} | N/A | NOT RUN | N/A | persistFlowHold absent and minimal atomic '
                                  f'publication present in factory image init | {", ".join(acceptance.MINIMAL_CASES)}',
                                  result)
                self.assertIn(f'Case totals: {13 if fault == "none" else 11} passed / 13 required', result)
                if fault in ('writer', 'flows'):
                    self.assertIn('factory probe ROM init, writer or starting flows differs', result)

    def test_factory_cut_refuses_a_marker_with_unrelated_starting_flows(self):
        vm = Mock()
        receipt = (b'committed', b'a'*64, b'b'*64, b'image', b'd'*64, b'e'*64)
        with self.assertRaisesRegex(RuntimeError, 'factory marker old digest'):
            minimal_flows.verify_disk(vm, receipt, phase='committed', factory=True, shipped_old=b'c'*64,
                                      shipped_init=b'd'*64, shipped_writer=b'e'*64)
        vm.stop.assert_called_once_with(cut=True)
        vm.verify_cut_disk.assert_not_called()

    def test_factory_cut_refuses_an_overlay_writer_or_init(self):
        for init, writer in ((b'c'*64, b'e'*64), (b'd'*64, b'c'*64)):
            with self.subTest(init=init, writer=writer):
                vm = Mock()
                receipt = (b'committed', b'a'*64, b'b'*64, b'image', init, writer)
                with self.assertRaisesRegex(RuntimeError, 'different running init or atomic writer'):
                    minimal_flows.verify_disk(vm, receipt, phase='committed', factory=True, shipped_old=b'a'*64,
                                              shipped_init=b'd'*64, shipped_writer=b'e'*64)
                vm.stop.assert_called_once_with(cut=True)
                vm.verify_cut_disk.assert_not_called()

    def test_cli_rejects_a_separate_probe_archive(self):
        stderr = io.StringIO()
        with redirect_stderr(stderr), self.assertRaises(SystemExit) as result:
            acceptance.main([
                '--osi-version', '0.8.3', '--chirpstack-version', '4.12.1', '--release', 'release',
                '--release-revision', 'a'*40, '--fixtures', 'fixtures', '--run-root', 'evidence',
                '--minimal-probe-image', 'independent.img.gz',
            ])
        self.assertEqual(result.exception.code, 2)
        self.assertIn('unrecognized arguments: --minimal-probe-image', stderr.getvalue())

    def test_tools_revision_refuses_checkout_mismatch_and_changes(self):
        root = acceptance.HERE.parents[1]
        discovery = f'{root}\n{"a"*40}\n'
        with patch.object(acceptance.subprocess, 'check_output', return_value=discovery):
            with self.assertRaisesRegex(ValueError, 'HEAD differs'):
                acceptance.tools_checkout_revision('b'*40)
        with patch.object(acceptance.subprocess, 'check_output', side_effect=[discovery, ' M acceptance.py']):
            with self.assertRaisesRegex(ValueError, 'tools differ'):
                acceptance.tools_checkout_revision('a'*40)
        with patch.object(acceptance.subprocess, 'check_output', side_effect=[discovery, '']):
            self.assertEqual(acceptance.tools_checkout_revision('a'*40), 'a'*40)

    def test_minimal_probe_copy_matches_source_pin_and_keeps_original_untouched(self):
        with tempfile.TemporaryDirectory() as directory:
            root = Path(directory)
            source = root/'release'
            init = source/minimal_flows.INIT
            init.parent.mkdir(parents=True)
            init.write_text(minimal_flows.ATOMIC_PUBLISH + '\n')
            original = init.read_bytes()
            deploy = source/'deploy.sh'
            deploy.write_text('NODE_RED_INIT_SHA256="' + hashlib.sha256(original).hexdigest() + '"\n')
            probe = root/'probe'
            new_digest = minimal_flows.prepare_probe_release(source, probe)
            self.assertEqual(init.read_bytes(), original)
            self.assertIn('minimal-flows-cut', (probe/minimal_flows.INIT).read_text())
            self.assertEqual(new_digest, hashlib.sha256((probe/minimal_flows.INIT).read_bytes()).hexdigest())
            self.assertEqual(minimal_flows.INIT_PIN.findall((probe/'deploy.sh').read_text()), [new_digest])
            with self.assertRaisesRegex(ValueError, 'pin the original'):
                deploy.write_text('NODE_RED_INIT_SHA256="' + 'a' * 64 + '"\n')
                minimal_flows.prepare_probe_release(source, root/'invalid')

    def test_upgrade_safety_runs_all_abc_cases_and_requires_pass_from_each(self):
        with tempfile.TemporaryDirectory() as directory:
            root = Path(directory)
            folder = root/'v0.8.1'
            folder.mkdir()
            (folder/'rpi5.img.gz').write_bytes(b'fixture')
            (folder/'SHA256SUMS').write_text(hashlib.sha256(b'fixture').hexdigest() + '  rpi5.img.gz\n')
            args = SimpleNamespace(fixtures=root, qemu=None, ram=8,
                                   release_revision='a'*40, osi_version='0.8.3',
                                   flows_power_cut_only=False, customer_fixture_only=False,
                                   upgrade_boot_safety_only=True)

            def upgrade(*_, transfer, **__):
                if transfer == 'init':
                    raise RuntimeError('wrong on-disk bytes')

            with (redirect_stdout(io.StringIO()), patch.object(acceptance, 'Guest') as guest,
                  patch.object(acceptance, 'build_media'), patch.object(acceptance, 'ready'),
                  patch.object(acceptance, 'verify_zero_recovery') as zero,
                  patch.object(acceptance, 'verify_missing_pristine_hold') as hold,
                  patch.object(acceptance, 'upgrade', side_effect=upgrade) as deploy):
                self.assertEqual(acceptance.run_cases(args, root, root, root, 'recovery', False), 1)
            self.assertEqual(deploy.call_count, 5)
            self.assertTrue(all(call.kwargs['direct_io'] for call in guest.call_args_list))
            zero.assert_called_once()
            hold.assert_called_once()
            result = (root/'results.log').read_text()
            self.assertRegex(result, r'C\. Interrupted init install\s+FAIL')
            self.assertIn('Focused acceptance: FAIL', result)
            self.assertNotIn(' | N/A | ', result)
            self.assertNotIn('Candidate acceptance:', result)

    def test_migration_0073_resolves_both_pinned_triggers(self):
        _, triggers = boot_safety.migrated_triggers(Path(__file__).resolve().parents[2])
        self.assertEqual(set(triggers), {'trg_dp_zone_env_outbox_ai', 'trg_dp_zone_env_outbox_au'})


class SlowBootBudgetTests(unittest.TestCase):
    def ready_script(self, **budget):
        vm = Mock()
        with (patch.object(acceptance, 'checked') as checked,
              patch.object(acceptance, 'sql', return_value='ok')):
            acceptance.ready(vm, **budget)
        (_, script, timeout), _ = checked.call_args
        return script, timeout

    LEGACY_READY = """for i in $(seq 1 180); do
if test -s /data/db/farming.db && wget -q -T 2 -O /tmp/gui http://127.0.0.1:1880/gui/ && grep -qi '<html' /tmp/gui && pidof chirpstack >/dev/null && wget -q -T 2 -O /dev/null http://127.0.0.1:8080/; then
ip addr add 192.0.2.15/24 dev br-lan 2>/dev/null || ip -4 addr show | grep -q 192.0.2.15 || ip addr add 192.0.2.15/24 dev eth0
exit $?
fi
sleep 3
done
exit 1"""

    def test_default_ready_is_the_legacy_script_and_timeout(self):
        script, timeout = self.ready_script()
        self.assertEqual(script, self.LEGACY_READY)
        self.assertEqual(timeout, 800)

    def test_slow_boot_ready_uses_a_guest_deadline_of_900_s(self):
        self.assertEqual(SLOW_BOOT_SECONDS, 900)
        script, timeout = self.ready_script(budget=SLOW_BOOT_SECONDS)
        self.assertIn('end=$(( $(up) + 900 ))', script)
        self.assertIn('\nwhile left; do\nif probe; then\n', script)
        self.assertEqual(script.count('bounded wget -q -T 2 '), 2)
        self.assertEqual(script.count('left && bounded wget'), 2)
        self.assertIn('\nsleep 3\n', script)
        self.assertNotIn('seq', script)
        self.assertEqual(timeout, acceptance.ready_host_timeout(SLOW_BOOT_SECONDS))

    def test_slow_boot_host_timeout_outlasts_the_last_guest_round(self):
        for budget in (60, SLOW_BOOT_SECONDS):
            for poll in (1, acceptance.READY_POLL_SECONDS, 10):
                last_round_ends = budget + acceptance.READY_PROBE_SECONDS + poll
                self.assertGreater(acceptance.ready_host_timeout(budget, poll), last_round_ends)
        # Two wget probes, each bounded by a 2 s connect and a 2 s read timeout.
        self.assertEqual(acceptance.READY_PROBE.count('wget -q -T 2 '), 2)
        self.assertGreaterEqual(acceptance.READY_PROBE_SECONDS, 2 * 2 * 2)

    @staticmethod
    def shells():
        return [shell for shell in (['sh'], ['dash'], ['busybox', 'sh']) if shutil.which(shell[0])]

    def run_slow_script(self, shell, wget, budget, poll):
        # Runs the generated guest script on the host with stub commands; the
        # host's /proc/uptime drives the deadline as the guest's does.
        with tempfile.TemporaryDirectory() as directory:
            root = Path(directory)
            stubs = root/'bin'
            stubs.mkdir()
            for name, body in (('wget', wget), ('pidof', 'exit 0'), ('ip', 'exit 0')):
                (stubs/name).write_text(f'#!/bin/sh\n{body}\n')
                (stubs/name).chmod(0o755)
            (root/'farming.db').write_bytes(b'db')
            script, timeout = acceptance.ready_script(budget, poll)
            # Absolute stub paths: a busybox built with standalone applets runs its
            # own wget and pidof before searching PATH.
            replacements = {'/data/db/farming.db': quote(str(root/'farming.db')), '/tmp/gui': quote(str(root/'gui')),
                            'bounded wget ': f'bounded {quote(str(stubs/"wget"))} ',
                            'pidof chirpstack': f'{quote(str(stubs/"pidof"))} chirpstack',
                            acceptance.READY_ADDRESS: quote(str(stubs/'ip'))}
            for old, new in replacements.items():
                self.assertIn(old, script)
                script = script.replace(old, new)
            env = dict(os.environ, STUB_ROOT=str(root))
            began = time.monotonic()
            result = subprocess.run([*shell, '-c', script], env=env, stdout=subprocess.DEVNULL,
                                    stderr=subprocess.DEVNULL, timeout=timeout)
            elapsed = time.monotonic() - began
            pids = [int(line) for line in (root/'pids').read_text().split()] if (root/'pids').exists() else []
            return result.returncode, elapsed, timeout, pids

    def test_slow_boot_probe_that_keeps_sending_is_killed_inside_the_host_timeout(self):
        # Mimics uclient-fetch rearming -T on every body chunk: never finishes.
        trickle = 'echo $$ >> "$STUB_ROOT/pids"\nwhile :; do echo chunk; sleep 1; done'
        budget, poll = 2, 1
        for shell in self.shells():
            with self.subTest(shell=shell):
                code, elapsed, timeout, pids = self.run_slow_script(shell, trickle, budget, poll)
                self.assertEqual(code, 1)
                self.assertGreaterEqual(elapsed, acceptance.READY_WGET_SECONDS)
                self.assertLess(elapsed, budget + acceptance.READY_PROBE_SECONDS + poll)
                self.assertLess(elapsed, timeout)
                self.assertEqual(len(pids), 1)
                with self.assertRaises(ProcessLookupError):
                    os.kill(pids[0], 0)

    def test_slow_boot_script_succeeds_when_both_probes_answer(self):
        answer = ('while [ $# -gt 0 ]; do [ "$1" = -O ] && out=$2; shift; done\n'
                  'echo "<html>" > "$out"')
        for shell in self.shells():
            with self.subTest(shell=shell):
                code, elapsed, _, _ = self.run_slow_script(shell, answer, 30, 1)
                self.assertEqual(code, 0)
                self.assertLess(elapsed, acceptance.READY_PROBE_SECONDS)

    def test_only_the_0_8_1_upgrade_boot_gets_the_slow_boot_budget(self):
        for old, expected in (('0.8.0', unittest.mock.call('vm')),
                              ('0.8.1', unittest.mock.call('vm', budget=SLOW_BOOT_SECONDS))):
            with self.subTest(old=old), patch.object(acceptance, 'ready') as ready:
                acceptance.upgrade_boot_ready('vm', old)
            self.assertEqual(ready.call_args_list, [expected])

    def test_old_release_upgrade_boot_gets_the_slow_boot_budget(self):
        with tempfile.TemporaryDirectory() as directory:
            root = Path(directory)
            folder = root/'fixtures'/'v0.8.1'
            folder.mkdir(parents=True)
            image = folder/'rpi5.img.gz'
            image.write_bytes(b'fixture')
            (folder/'SHA256SUMS').write_text(hashlib.sha256(b'fixture').hexdigest() + '  rpi5.img.gz\n')
            args = SimpleNamespace(fixtures=root/'fixtures', candidate=image, qemu=None, ram=8,
                                   candidate_sha256=hashlib.sha256(b'fixture').hexdigest(),
                                   release_revision='a'*40, osi_version='0.8.3',
                                   flows_power_cut_only=True, customer_fixture_only=False,
                                   upgrade_boot_safety_only=False)
            guests = []
            def make(*_args, **_options):
                guests.append(Mock())
                return guests[-1]
            with (redirect_stdout(io.StringIO()), patch.object(acceptance, 'Guest', side_effect=make),
                  patch.object(acceptance, 'build_media'), patch.object(acceptance, 'ready') as ready,
                  patch.object(acceptance, 'cut_after_flows_patch', return_value='ok'),
                  patch.object(acceptance, 'upgrade', side_effect=RuntimeError('stop after ready'))):
                acceptance.run_cases(args, root, root, root, 'recovery', False)
        later_boot, upgrade_boot = guests[1], guests[2]
        self.assertIn(unittest.mock.call(later_boot), ready.call_args_list)
        self.assertIn(unittest.mock.call(upgrade_boot, budget=SLOW_BOOT_SECONDS), ready.call_args_list)

    def test_customer_fixture_old_release_boots_get_the_slow_boot_budget(self):
        with tempfile.TemporaryDirectory() as directory:
            root = Path(directory)
            args = SimpleNamespace(customer_image=root/'image', customer_source=root/'source',
                                   release_revision='a'*40, qemu=root/'qemu', ram=8)
            identity = {'rom_gui_sha256': 'f'*64}
            ready = Mock()
            stop = RuntimeError('stop after the 0.8.1 boot')
            with (patch.object(customer_fixture, 'verified_inputs', return_value=(root/'factory', [], identity)),
                  patch.object(customer_fixture, 'build_media'), patch.object(customer_fixture, 'Guest') as guest,
                  patch.object(customer_fixture, 'checked', side_effect=['', 'f'*64]),
                  patch.object(customer_fixture, 'sql', return_value='0'),
                  patch.object(customer_fixture, 'track_install'),
                  patch.object(customer_fixture, 'version', side_effect=[None, stop])):
                with self.assertRaisesRegex(RuntimeError, 'stop after the 0.8.1 boot'):
                    (root/'scratch').mkdir()
                    (root/'receipts').mkdir()
                    customer_fixture.run(args, root/'scratch', root/'receipts', root/'release', ready)
        vm = guest.return_value
        self.assertEqual(ready.call_args_list, [unittest.mock.call(vm, budget=SLOW_BOOT_SECONDS)] * 2)

    def guest(self, directory, *, private):
        vm = Guest.__new__(Guest)
        vm.work = vm.receipts = Path(directory)
        vm.qemu = vm.work/'qemu'
        vm.process = vm.bridge = vm.radio = None
        vm.boots = 0
        vm.port = 49152
        vm.ram = 8
        vm.private = private
        vm.upgrade = None
        vm.direct_io = True
        (vm.work/'cmdline.txt').write_text('root=/dev/mmcblk0p2')
        return vm

    def test_before_console_marker_wait_is_the_slow_boot_budget(self):
        with tempfile.TemporaryDirectory() as directory:
            vm = self.guest(directory, private=True)
            marker = re.search(rb'(x)', b'x')
            with (patch('suite_vm.subprocess.Popen', return_value=Mock()),
                  patch.object(vm, 'expect', return_value=marker) as expect):
                self.assertEqual(vm.start(before_console=rb'(x)'), (b'x',))
            expect.assert_called_once_with(rb'(x)', SLOW_BOOT_SECONDS)
            vm.radio.close()

    def test_console_is_kept_per_boot_except_for_private_guests(self):
        for private in (False, True):
            with self.subTest(private=private), tempfile.TemporaryDirectory() as directory:
                vm = self.guest(directory, private=private)
                vm.boots = 2
                read, write = os.pipe()
                vm.process = SimpleNamespace(stdout=os.fdopen(read, 'rb'), stdin=None, poll=lambda: 0)
                vm.buf = b''
                os.write(write, b'boot log\nmarker\nafter marker')
                vm.expect(rb'marker\n', 5)
                os.write(write, b' and shutdown')
                os.close(write)
                process, vm.process = vm.process, None
                vm.drain(process)
                vm.finish_serial()
                process.stdout.close()
                serial = vm.receipts/'qemu-2.serial'
                if private:
                    self.assertFalse(serial.exists())
                    self.assertEqual(list(vm.receipts.iterdir()), [vm.receipts/'cmdline.txt'])
                else:
                    self.assertEqual(serial.read_bytes(), b'boot log\nmarker\nafter marker and shutdown')

    def test_failed_receipt_write_keeps_the_chunk_for_the_parser(self):
        with tempfile.TemporaryDirectory() as directory:
            vm = self.guest(directory, private=False)
            vm.boots = 1
            read, write = os.pipe()
            vm.process = SimpleNamespace(stdout=os.fdopen(read, 'rb'))
            vm.buf = b''
            os.write(write, b'marker\n')
            with patch.object(vm, 'capture', side_effect=OSError('disk full')):
                self.assertEqual(vm.expect(rb'marker\n', 5).group(0), b'marker\n')
            os.close(write)
            vm.process.stdout.close()
            self.assertIn("console receipt write failed: OSError('disk full')",
                          (vm.receipts/'harness-events.log').read_text())

    def test_serial_receipt_keeps_head_and_tail_with_a_marker(self):
        with tempfile.TemporaryDirectory() as directory:
            vm = self.guest(directory, private=False)
            vm.SERIAL_HEAD_BYTES, vm.SERIAL_TAIL_BYTES = 10, 6
            vm.boots = 1
            for chunk in (b'0123456', b'789abcdefghij', b'klmnopqrst'):
                vm.capture(chunk)
            self.assertEqual((vm.receipts/'qemu-1.serial').read_bytes(), b'0123456789')
            vm.finish_serial()
            self.assertEqual((vm.receipts/'qemu-1.serial').read_bytes(),
                             b'0123456789\n[osi-harness: 14 console bytes omitted after the first 10; '
                             b'last 6 follow]\nopqrst')
            vm.boots = 2
            vm.capture(b'next boot')
            self.assertEqual((vm.receipts/'qemu-2.serial').read_bytes(), b'next boot')

    def test_stop_gives_up_draining_a_live_writer_after_a_failed_reap(self):
        with tempfile.TemporaryDirectory() as directory:
            vm = self.guest(directory, private=False)
            vm.DRAIN_SECONDS = 0.3
            vm.boots = 1
            read, write = os.pipe()
            # Bytes already waiting when the drain starts: the receipt check does
            # not depend on when the writer thread is first scheduled.
            os.write(write, b'still talking\n')
            running = True
            def chatty():
                while running:
                    try:
                        os.write(write, b'still talking\n')
                    except OSError:
                        return
                    time.sleep(0.01)
            with ThreadPoolExecutor(1) as pool:
                pool.submit(chatty)
                vm.process = SimpleNamespace(stdout=os.fdopen(read, 'rb'), stdin=None, poll=lambda: None)
                began = time.monotonic()
                try:
                    with patch('suite_vm.reap', side_effect=subprocess.TimeoutExpired('qemu', 5)):
                        with self.assertRaises(ExceptionGroup):
                            vm.stop()
                finally:
                    running = False
                elapsed = time.monotonic() - began
                os.close(write)
            self.assertLess(elapsed, 3)
            self.assertIn('console drain gave up after 0.3 s', (vm.receipts/'harness-events.log').read_text())
            self.assertTrue((vm.receipts/'qemu-1.serial').read_bytes().startswith(b'still talking\n'))


class BoundaryTests(unittest.TestCase):
    def test_real_and_symlinked_git_paths_are_rejected(self):
        with tempfile.TemporaryDirectory() as directory:
            root = Path(directory)
            worktree = root/'repo'
            worktree.mkdir()
            (worktree/'.git').touch()
            alias = root/'alias'
            alias.symlink_to(worktree)
            for path in (worktree, alias):
                with self.assertRaises(ValueError):
                    external_path(path)
            self.assertEqual(external_path(root), root.resolve())

    def test_private_tool_error_is_not_printed_or_saved(self):
        with tempfile.TemporaryDirectory() as directory:
            root = Path(directory)
            args = SimpleNamespace(flows_power_cut_only=False, customer_fixture_only=True,
                                   upgrade_boot_safety_only=False)
            stdout = io.StringIO()
            error = subprocess.CalledProcessError(1, ['tool', 'private-filename.img'])
            with (redirect_stdout(stdout), redirect_stderr(stdout),
                  patch.object(customer_fixture, 'run', side_effect=error)):
                self.assertEqual(acceptance.run_cases(args, root, root, root, 'unsupported', True), 1)
            self.assertNotIn('private-filename', stdout.getvalue() + (root/'results.log').read_text())
            self.assertIn('private case failed', stdout.getvalue())
            self.assertIn('[PROVISIONAL]: opt-in qualification', stdout.getvalue())

    def test_both_processes_are_reaped_even_when_exit_receipt_fails(self):
        with tempfile.TemporaryDirectory() as directory:
            vm = Guest.__new__(Guest)
            guest, bridge = Mock(), Mock()
            vm.process, vm.bridge = guest, bridge
            vm.radio, peer = socket.socketpair()
            host = vm.radio
            vm.boots = 1
            vm.receipts = Path(directory)/'missing'
            vm.private = False
            guest.poll.return_value = bridge.poll.return_value = None
            guest.wait.side_effect = bridge.wait.side_effect = [subprocess.TimeoutExpired('qemu', 5), -9]
            with peer, self.assertRaises(ExceptionGroup):
                vm.stop()
            for process in (guest, bridge):
                process.terminate.assert_called_once()
                process.kill.assert_called_once()
                self.assertEqual(process.wait.call_count, 2)
            self.assertIsNone(vm.process)
            self.assertIsNone(vm.bridge)
            self.assertIsNone(vm.radio)
            self.assertEqual(host.fileno(), -1)

    def test_firmware_override_checksum(self):
        with tempfile.TemporaryDirectory() as directory:
            source = Path(directory)/'firmware'
            target = source.with_name('copy')
            source.write_bytes(b'firmware')
            with self.assertRaisesRegex(ValueError, 'SHA-256 mismatch'):
                run.verified_copy(source, 'a'*64, target)
            run.verified_copy(source, hashlib.sha256(b'firmware').hexdigest(), target)

    def test_wrapper_refuses_nested_holder(self):
        path = Path(acceptance.__file__).with_name('acceptance.sh')
        result = subprocess.run(['bash', path, '--customer-fixture-only'],
                                env=dict(os.environ, OSI_HEAVY_HOLDER='fixture:1'),
                                capture_output=True, text=True)
        self.assertEqual(result.returncode, 2)
        self.assertIn('outside the current holder', result.stderr)

    def test_private_pair_rejects_a_different_candidate_archive_migration(self):
        with tempfile.TemporaryDirectory() as directory:
            root = Path(directory)
            image = root/'factory.img.gz'
            image.write_bytes(b'fixture')
            directory = 'database/migrations/ordered'
            legacy = f'0076__{customer_fixture.ARCHIVE}'
            candidate = f'0080__{customer_fixture.ARCHIVE}'
            sql = b'SELECT 1;'
            digest = hashlib.sha256(sql).hexdigest()
            with tarfile.open(root/'customer.tar.gz', 'w:gz') as bundle:
                for name, data in [(legacy, sql), ('CHECKSUMS.json', json.dumps({legacy: digest}).encode())]:
                    item = tarfile.TarInfo('./' + directory + '/' + name)
                    item.size = len(data)
                    bundle.addfile(item, io.BytesIO(data))
            bundle_sha = hashlib.sha256((root/'customer.tar.gz').read_bytes()).hexdigest()
            (root/'customer.tar.gz.sha256').write_text(bundle_sha+'  customer.tar.gz\n')
            (root/customer_fixture.PROVENANCE).write_text(json.dumps({
                'rom_gui_sha256': 'a'*64, 'legacy_revision': 'b'*40,
                'factory_image_sha256': hashlib.sha256(image.read_bytes()).hexdigest(),
                'legacy_bundle_sha256': bundle_sha,
            }))
            for name in customer_fixture.FILES[2:]:
                (root/name).write_bytes(b'fixture')
            (root/'SHA256SUMS').write_text(''.join(
                f'{hashlib.sha256(path.read_bytes()).hexdigest()}  {path.name}\n' for path in root.iterdir()))
            manifest = root/directory/'CHECKSUMS.json'
            manifest.parent.mkdir(parents=True)
            manifest.write_text(json.dumps({candidate: digest}))
            (manifest.parent/candidate).write_bytes(sql)
            staged_image, files, identity = customer_fixture.verified_inputs(image, root, root, root/'verified')
            self.assertNotEqual(staged_image, image)
            self.assertEqual(staged_image.read_bytes(), image.read_bytes())
            self.assertNotIn(customer_fixture.PROVENANCE, files)
            self.assertEqual(identity['legacy_archive_migration_sha256'], digest)
            manifest.write_text(json.dumps({candidate: 'a'*64}))
            with self.assertRaisesRegex(ValueError, 'does not match candidate migration 0080'):
                customer_fixture.verified_inputs(image, root, root, root/'rejected')


class ProgressTests(unittest.TestCase):
    def exercise(self, replies, *, hard=60):
        clock = 0

        def sleep(seconds):
            nonlocal clock
            clock += seconds

        with tempfile.TemporaryDirectory() as directory:
            log = Path(directory)/'progress.jsonl'
            responses = iter(replies)

            def checked(_, shell, timeout=90):
                subprocess.run(['sh', '-n'], input=shell, text=True, check=True, capture_output=True)
                return next(responses)

            with (patch.object(customer_fixture, 'checked', side_effect=checked),
                  patch.object(customer_fixture.time, 'monotonic', lambda: clock),
                  patch.object(customer_fixture.time, 'sleep', sleep),
                  patch.object(customer_fixture, 'IDLE_SECONDS', 20),
                  patch.object(customer_fixture, 'HARD_SECONDS', hard),
                  patch.object(customer_fixture, 'POLL_SECONDS', 10)):
                error = None
                try:
                    customer_fixture.track_install(None, log, 'legacy', 'install.sh', 'bundle.tar.gz', 'cache.tar')
                except customer_fixture.FixtureFailure as exc:
                    error = str(exc)
            return error, [json.loads(line) for line in log.read_text().splitlines()]

    def test_forward_progress_extends_idle_deadline_and_records_rc(self):
        error, rows = self.exercise(['-', '', '2 - 1 0 -', '2 - 2 0 -', '2 - 3 0 -', '3 76 3 1 0'])
        self.assertIsNone(error)
        self.assertEqual(rows[-1]['elapsed_seconds'], 30)
        self.assertEqual(rows[-1]['current_ledger'], 76)
        self.assertEqual(rows[-1]['installer_rc'], 0)

    def test_unchanged_phase_times_out(self):
        error, rows = self.exercise(['76', '', '2 76 0 0 -', '2 76 0 0 -'])
        self.assertIn('no-progress-timeout', error)
        self.assertEqual(rows[-1]['current_ledger'], 76)
        self.assertIsNone(rows[-1]['installer_rc'])

    def test_hard_limit_and_nonzero_exit_are_distinct(self):
        error, _ = self.exercise(['0', '', '2 1 1 0 -', '2 2 2 0 -'], hard=20)
        self.assertIn('hard-timeout', error)
        error, rows = self.exercise(['0', '', '2 1 1 0 7'])
        self.assertIn('installer returned 7', error)
        self.assertEqual(rows[-1]['installer_rc'], 7)


class TailscaleBootTests(unittest.TestCase):
    # Syslog lines as the image's persistent sink writes them.
    @staticmethod
    def line(second, text):
        return f'Sun Apr 13 16:50:{second:02d} 2025 ' + text

    RC = 'daemon.notice procd: /etc/rc.d/'
    # As logd writes them on the 0.8.0 fixture (gate bc561582, diag/inspect):
    # the daemon logs through its procd instance, BusyBox logger adds no pid.
    DAEMON = ('daemon.err tailscaled[4302]: 2025/04/13 16:50:35 Program starting: v1.80.3-1 (OpenWrt), Go 1.23.8: '
              '[]string{"/usr/sbin/tailscaled", "--port", "41641", "--state", "/etc/tailscale/tailscaled.state"}')

    def stall_log(self, *, gave_up_after=15, link='S99tailscale'):
        lines = [
            self.line(0, 'user.notice node-red.init: chirpstack config CHIRPSTACK_APP_SENSORS source=uci'),
            self.line(20, self.RC + f'{link}: Program starting: v1.80.3-1 (OpenWrt), Go 1.23.8: []string{"/usr/sbin/tailscaled", "--cleanup"}'),
            self.line(20, 'user.notice osi-test-cleanup: cleanup stall started'),
            self.line(20 + gave_up_after, 'user.notice tailscale: cleanup did not finish in 15 s; continuing without it'),
            self.line(20 + gave_up_after, self.DAEMON),
        ]
        return '\n'.join(lines)

    def normal_log(self):
        return '\n'.join([
            self.line(0, 'user.notice node-red.init: chirpstack config CHIRPSTACK_APP_SENSORS source=uci'),
            self.line(20, self.RC + 'S99tailscale: Program starting: v1.80.3-1 (OpenWrt), Go 1.23.8: []string{"/usr/sbin/tailscaled", "--cleanup"}'),
            self.line(20, self.RC + 'S99tailscale: flushing log.'),
            self.line(21, self.DAEMON),
        ])

    def test_the_limit_is_read_from_the_shipped_init(self):
        repo = Path(__file__).resolve().parents[2]
        init = (repo/tailscale_boot.INIT).read_text()
        self.assertEqual(tailscale_boot.cleanup_limit(init), 15)
        package = (repo/'scripts/fixtures/tailscale-package-init/1.80.3-r1.init').read_text()
        with self.assertRaisesRegex(ValueError, 'OSI_CLEANUP_LIMIT'):
            tailscale_boot.cleanup_limit(package)

    def test_the_stall_stand_in_is_one_blocked_process_and_runs_the_real_daemon(self):
        self.assertNotIn('&', tailscale_boot.STALL_WRAPPER)
        self.assertIn('exec 3</tmp/osi-cleanup-stall.fifo', tailscale_boot.STALL_WRAPPER)
        self.assertIn('exec /usr/sbin/tailscaled.real "$@"', tailscale_boot.STALL_WRAPPER)
        self.assertIn('--cleanup', tailscale_boot.STALL_WRAPPER)
        # The technician command finds the stand-in, and not the shell running the command.
        pattern = 'tailscaled --cleanu[p]'
        self.assertRegex('/bin/sh /usr/sbin/tailscaled --cleanup', pattern)
        self.assertNotRegex(f"sh -c kill -9 $(pgrep -f '{pattern}')", pattern)

    def test_the_runbook_carries_the_technician_command_the_harness_runs(self):
        repo = Path(__file__).resolve().parents[2]
        recipe = (repo/'.claude/skills/osi-live-ops-runbook/references/repair.md').read_text()
        for command in (tailscale_boot.TECHNICIAN_COMMAND, tailscale_boot.ALTERNATE_COMMAND):
            self.assertIn(command, recipe)
        self.assertEqual(tailscale_boot.ALTERNATE_COMMAND, 'kill -9 $(' + tailscale_boot.PS_LOOKUP + ')')

    def test_a_stalled_cleanup_is_cut_short_after_the_limit_and_node_red_came_first(self):
        receipt = tailscale_boot.stall_verdict(self.stall_log(), 15)
        self.assertIn('stalled 15 s', receipt)
        self.assertIn('Node-RED init came first', receipt)
        self.assertIn('--port', receipt)

    def test_a_stall_verdict_names_what_is_wrong(self):
        for label, log, limit, reason in [
            ['no give-up', '\n'.join(self.stall_log().splitlines()[:3]), 15, 'did not give up'],
            ['no stall announcement', self.stall_log().replace('cleanup stall started', 'x'), 15, 'did not announce'],
            # syslog is chronological: a later line is a later event.
            ['Node-RED after tailscale', '\n'.join(self.stall_log().splitlines()[1:]
                                                  + [self.line(45, 'user.notice node-red.init: chirpstack config CHIRPSTACK_APP_SENSORS source=uci')]),
             15, 'order is wrong'],
            ['gave up late', self.stall_log(gave_up_after=40), 15, '40 s after the stall began'],
            ['gave up early', self.stall_log(gave_up_after=10), 15, '10 s after the stall began'],
            ['ran from S80', self.stall_log(link='S80tailscale'), 15, 'S80tailscale instead of S99tailscale'],
            ['daemon not started', self.stall_log().replace('--port', '--no-port'), 15, 'daemon did not start'],
            ['only a flows commit from Node-RED', self.stall_log().replace(
                'chirpstack config CHIRPSTACK_APP_SENSORS source=uci', 'INFO: committed flows.json digest=' + 'a' * 64 + ' stamp=x'),
             15, 'did not log its start'],
            ['give-up from another tag', self.stall_log().replace('user.notice tailscale:', 'user.notice other:'), 15, 'did not give up'],
            ['cut short at another limit', self.stall_log(gave_up_after=15), 30, 'did not give up'],
        ]:
            with self.subTest(label):
                with self.assertRaisesRegex(RuntimeError, reason):
                    tailscale_boot.stall_verdict(log, limit)

    def test_a_normal_boot_finishes_its_cleanup_and_starts_the_daemon(self):
        self.assertIn('flushing log.', tailscale_boot.normal_verdict(self.normal_log(), 15))

    def test_a_cleanup_the_real_binary_hangs_on_is_reported_as_cut_short(self):
        log = self.normal_log().replace(self.line(20, self.RC + 'S99tailscale: flushing log.'),
                                        self.line(35, 'user.notice tailscale: cleanup did not finish in 15 s; continuing without it'))
        self.assertIn('cut short after 15 s', tailscale_boot.normal_verdict(log, 15))

    def test_a_normal_verdict_names_what_is_wrong(self):
        for label, log, reason in [
            ['cleanup never ran', self.line(0, 'daemon.notice procd: /etc/rc.d/S99node-red: x'), 'real cleanup did not run'],
            ['neither finished nor cut short', '\n'.join(self.normal_log().splitlines()[:2]), 'neither finished nor'],
            ['still the stand-in', self.normal_log() + '\n' + self.line(1, 'user.notice osi-test-cleanup: cleanup stall started'),
             'stand-in was still installed'],
            ['ran from S80', self.normal_log().replace('S99tailscale', 'S80tailscale'), 'S80tailscale instead of S99tailscale'],
            ['daemon missing', '\n'.join(self.normal_log().splitlines()[:3]), 'daemon did not start'],
        ]:
            with self.subTest(label):
                with self.assertRaisesRegex(RuntimeError, reason):
                    tailscale_boot.normal_verdict(log, 15)

    def test_the_syslog_time_of_day_is_read_across_the_minute(self):
        self.assertEqual(tailscale_boot.line_seconds('Sun Apr 13 16:50:58 2025 x'), 16 * 3600 + 50 * 60 + 58)
        gave_up = tailscale_boot.stall_verdict(self.stall_log(gave_up_after=15).replace('16:50:35', '16:51:03')
                                               .replace('16:50:20', '16:50:48'), 15)
        self.assertIn('stalled 15 s', gave_up)

    def test_every_command_sent_to_the_guest_parses_as_shell(self):
        # Over LAN SSH goes one line; the process-start script goes over the console.
        over_ssh = ('MILESTONES', 'HELD_STATE', 'STALLED_CLEANUP', 'PS_LOOKUP', 'ONSITE_LOOKUP', 'ONSITE_COMMAND', 'HANG_AGE')
        for name in (*over_ssh, 'PROCESS_STARTS'):
            text = getattr(tailscale_boot, name).replace('DAEMON', 'tailscaled')
            for shell in ('sh', 'bash'):
                run = subprocess.run([shell, '-n', '-c', text], capture_output=True, text=True)
                self.assertEqual(run.returncode, 0, f'{name} under {shell}: {run.stderr}')
            if name in over_ssh:
                self.assertNotIn('\n', text, f'{name} is one line')

    def test_the_on_site_line_is_pinned_and_differs_from_the_runbook_line_only_in_its_lookup(self):
        self.assertEqual(tailscale_boot.ONSITE_COMMAND,
                         "kill -9 $(ps w | grep '[t]ailscaled --cleanup' | awk '{print $1}')")
        self.assertEqual(tailscale_boot.ONSITE_LOOKUP, tailscale_boot.ONSITE_COMMAND[len('kill -9 $('):-1])
        self.assertEqual(tailscale_boot.ALTERNATE_COMMAND, 'kill -9 $(' + tailscale_boot.PS_LOOKUP + ')')
        self.assertEqual(tailscale_boot.TECHNICIAN_COMMAND, 'kill -9 $(' + tailscale_boot.STALLED_CLEANUP + ')')
        # Each lookup's pattern, applied to the text of the lookup itself, must not match.
        for lookup in (tailscale_boot.STALLED_CLEANUP, tailscale_boot.PS_LOOKUP, tailscale_boot.ONSITE_LOOKUP):
            self.assertNotRegex(lookup, 'tailscaled --cleanup')
        self.assertRegex('/usr/sbin/tailscaled --cleanup', 'tailscaled --cleanup')
        self.assertRegex('/bin/sh /usr/sbin/tailscaled --cleanup', 'tailscaled --cleanup')

    def test_field_and_start_readings(self):
        self.assertEqual(tailscale_boot.parse_fields('daemon= chirpstack=2833 node=up gui=\nage=235'),
                         {'chirpstack': '2833', 'node': 'up', 'age': '235'})
        self.assertEqual(tailscale_boot.process_starts('tailscaled.real 79\nchirpstack 76\nnode-red 72\n', 100),
                         {'tailscaled.real': 21, 'chirpstack': 24, 'node-red': 28})
        self.assertEqual(tailscale_boot.process_starts('chirpstack: no process found\n', 100), {})
        self.assertEqual(tailscale_boot.held_state('\n\nage=235\n'), ('', []))
        self.assertEqual(tailscale_boot.held_state('2833\nage=99\n'), ('2833', []))
        self.assertEqual(tailscale_boot.held_state('\nnodered-up\ngui-up\nage=99\n'), ('', ['nodered-up', 'gui-up']))

    def test_no_ssh_probe_matches_its_own_command_line(self):
        # dropbear runs each line as `sh -c <line>`; `ps w` shows that line.
        for name in ('MILESTONES', 'HELD_STATE', 'STALLED_CLEANUP', 'PS_LOOKUP', 'ONSITE_LOOKUP', 'HANG_AGE'):
            text = getattr(tailscale_boot, name)
            for pattern in re.findall(r"grep -q '([^']+)'|grep '([^']+)'|pgrep -f '([^']+)'|awk '/([^/]+)/", text):
                pattern = next(part for part in pattern if part)
                with self.subTest(name=name, pattern=pattern):
                    self.assertNotRegex('sh -c ' + text, pattern)

    def test_the_verdicts_read_real_fixture_lines(self):
        # Copied from the 0.8.0 fixture's persistent log (gate bc561582).
        real = ('Sun Apr 13 16:48:01 2025 daemon.err tailscaled[2079]: 2025/04/13 16:48:01 Program starting: '
                'v1.80.3-1 (OpenWrt), Go 1.23.8: []string{"/usr/sbin/tailscaled", "--port", "41641", "--state", '
                '"/etc/tailscale/tailscaled.state"}')
        self.assertRegex(real, tailscale_boot.DAEMON_START)
        self.assertNotRegex(real.replace('"--port", "41641", ', ''), tailscale_boot.DAEMON_START)
        self.assertRegex('Sun Apr 13 16:50:02 2025 user.notice node-red.init: chirpstack config '
                         'CHIRPSTACK_APP_SENSORS source=uci', tailscale_boot.NODE_RED_INIT)
        rc = ('Sun Apr 13 16:50:08 2025 daemon.notice procd: /etc/rc.d/S80tailscale: 2025/04/13 16:50:08 Program '
              'starting: v1.80.3-1 (OpenWrt), Go 1.23.8: []string{"/usr/sbin/tailscaled", "--cleanup"}')
        self.assertEqual(tailscale_boot.tail_rc([rc])[0][1], 'S80tailscale')
        self.assertNotRegex(rc, tailscale_boot.GAVE_UP)

    def test_the_console_prompt_of_a_held_boot_is_drained_and_not_judged(self):
        class Console:
            def __init__(self):
                self.buf = b''
                self.chunks = [b'procd: - init -\r\n' + tailscale_boot.CONSOLE + b'.\r\n']

            def expect(self, pattern, timeout):
                if self.chunks:
                    self.buf += self.chunks.pop(0)
                raise TimeoutError('guest serial timed out')

        console = Console()
        self.assertTrue(tailscale_boot.drain_console(console, 0.05))
        self.assertEqual(console.buf, b'.\r\n')
        self.assertFalse(tailscale_boot.drain_console(console, 0.05))

    def test_the_traced_install_keeps_the_steps_and_the_installer_output(self):
        self.assertTrue(tailscale_boot.TRACED_INSTALL.startswith('exec 2>/tmp/osi-install.trace\nset -x\n'))
        self.assertIn('--wait >/tmp/osi-install.out 2>&1', tailscale_boot.TRACED_INSTALL)
        self.assertNotIn('/dev/null 2>&1', tailscale_boot.TRACED_INSTALL)
        for text in (tailscale_boot.TRACED_INSTALL, tailscale_boot.INSTALL_DIAGNOSTICS):
            for shell in ('sh', 'bash'):
                run = subprocess.run([shell, '-n', '-c', text], capture_output=True, text=True)
                self.assertEqual(run.returncode, 0, run.stderr)

    def test_the_usb_media_carries_the_offline_launcher_companions(self):
        repo = Path(__file__).resolve().parents[2]
        launcher = (repo/'scripts/deploy-offline.sh').read_text()
        runtime = (repo/'scripts/deploy-offline-runtime.js').read_text()
        self.assertIn('deploy-offline-runtime.js', launcher)
        for name in re.findall(r"require\('\./([^']+)'\)", runtime):
            self.assertIn(name + '.js', upgrade_suite.OFFLINE_COMPANIONS)
        push = (repo/'scripts/deploy-push-bundle.sh').read_text()
        self.assertIn('for companion in ' + ' '.join(upgrade_suite.OFFLINE_COMPANIONS) + '; do', push)

    def test_the_boot_log_starts_at_the_last_marker_and_stays_fast_on_a_large_log(self):
        with tempfile.TemporaryDirectory() as directory:
            old, current = Path(directory)/'old.log', Path(directory)/'current.log'
            filler = ''.join(f'Sun Apr 13 16:00:00 2025 daemon.info dnsmasq[1]: line {n}\n' for n in range(200_000))
            old.write_text(filler + 'x osi-test: OSI-TAILSCALE-aaaa\nx tailscale: before\n')
            current.write_text(filler + 'x osi-test: OSI-TAILSCALE-aaaa\n' + filler
                               + 'x user.notice tailscale: after\nx node-red.init: chirpstack config A source=uci\n')
            script = tailscale_boot.boot_log_script('OSI-TAILSCALE-aaaa', (str(old), str(current)))
            began = time.monotonic()
            run = subprocess.run(['sh', '-c', script], capture_output=True, text=True, timeout=60)
            self.assertLess(time.monotonic() - began, 20)
            self.assertEqual(run.returncode, 0, run.stderr)
            self.assertEqual(run.stdout.splitlines(), ['x osi-test: OSI-TAILSCALE-aaaa', 'x user.notice tailscale: after',
                                                       'x node-red.init: chirpstack config A source=uci'])
            missing = subprocess.run(['sh', '-c', tailscale_boot.boot_log_script('OSI-TAILSCALE-bbbb', (str(old),))],
                                     capture_output=True, text=True, timeout=60)
            self.assertEqual((missing.returncode, missing.stdout), (0, ''))

    def test_the_upgraded_guest_gets_the_media_path_not_its_builder(self):
        media = Path('/nonexistent/upgrade.img')
        seen = {}

        class Stop(Exception):
            pass

        def make_guest(work, image, qemu, ram, **options):
            seen.update(options)
            raise Stop

        args = type('Args', (), {'qemu': Path('qemu'), 'ram': 4})()
        with tempfile.TemporaryDirectory() as directory:
            release = Path(directory)
            (release/tailscale_boot.INIT).parent.mkdir(parents=True)
            (release/tailscale_boot.INIT).write_text('OSI_CLEANUP_LIMIT=15\n')
            with self.assertRaises(Stop):
                tailscale_boot.run(args, release, release, release, make_guest, None, print,
                                   lambda old: release/'fixture.img.gz', lambda: media, None)
        self.assertEqual(seen['upgrade'], media)

    def test_the_focused_mode_expects_exactly_the_tailscale_cases(self):
        args = SimpleNamespace(tailscale_boot_only=True)
        self.assertEqual(set(acceptance.expected_cases(args, None, False)), set(tailscale_boot.CASES))
        plain = SimpleNamespace(tailscale_boot_only=False, flows_power_cut_only=False, customer_fixture_only=False,
                                upgrade_boot_safety_only=False)
        self.assertFalse(set(tailscale_boot.CASES) & set(acceptance.expected_cases(plain, None, False)))

    def test_the_focused_run_requires_a_pass_from_every_case_and_needs_no_candidate(self):
        with tempfile.TemporaryDirectory() as directory:
            root = Path(directory)
            init = root/tailscale_boot.INIT
            init.parent.mkdir(parents=True)
            init.write_text((Path(__file__).resolve().parents[2]/tailscale_boot.INIT).read_text())
            args = SimpleNamespace(fixtures=root, qemu=None, ram=8, release_revision='a' * 40, osi_version='0.8.5',
                                   flows_power_cut_only=False, customer_fixture_only=False,
                                   upgrade_boot_safety_only=False, tailscale_boot_only=True)
            def held(*call):
                for label in tailscale_boot.CASES:
                    call[5](label, Mock(side_effect=RuntimeError('held')))

            with (redirect_stdout(io.StringIO()), patch.object(tailscale_boot, 'run', side_effect=held) as run,
                  redirect_stderr(io.StringIO())):
                status = acceptance.run_cases(args, root, root, root, 'recovery', False)
            self.assertEqual(status, 1)
            run.assert_called_once()
            result = (root/'results.log').read_text()
            for label in tailscale_boot.CASES:
                self.assertIn(f'{label} | REQUIRED | FAIL | FAIL', result)
            self.assertIn('Focused acceptance: FAIL', result)

    @staticmethod
    def unguest(directory):
        # A Guest without an image: launch() only needs these attributes.
        vm = Guest.__new__(Guest)
        vm.work = vm.receipts = Path(directory)
        vm.qemu = vm.work/'qemu'
        vm.process = vm.bridge = vm.radio = None
        vm.boots = 0
        vm.ram = 8
        vm.private = False
        vm.direct_io = False
        vm.upgrade = None
        vm.extra_hostfwd = []
        (vm.work/'cmdline.txt').write_text('root=/dev/mmcblk0p2')
        vm.qemu.mkdir()
        for name in ('dtmerge', 'rpi5-bl31.bin'):
            (vm.qemu/name).write_bytes(b'')
        return vm

    def test_an_extra_host_forward_reaches_the_guest_lan_address(self):
        with tempfile.TemporaryDirectory() as directory:
            vm = self.unguest(directory)
            vm.port = 49152
            vm.extra_hostfwd.append((43210, 22))
            with patch('suite_vm.subprocess.Popen', return_value=Mock()) as popen:
                vm.launch()
            vm.stop()
            argv = popen.call_args_list[0].args[0]
            bridge = ' '.join(argv)
            # Every netdev definition follows its own -netdev flag; QEMU reads a
            # bare one as a disk image and the bridge exits.
            for position, word in enumerate(argv):
                if word.startswith(('user,', 'socket,', 'hubport,')):
                    self.assertEqual(argv[position - 1], '-netdev', word)
            self.assertIn('hostfwd=tcp:127.0.0.1:43210-192.0.2.15:22', bridge)
            self.assertIn('hostfwd=tcp:127.0.0.1:49152-192.0.2.15:1880', bridge)
            self.assertIn('restrict=on', bridge)

    def test_a_launch_without_extra_forwards_keeps_the_bridge_as_before(self):
        with tempfile.TemporaryDirectory() as directory:
            vm = self.unguest(directory)
            vm.port = 49152
            with patch('suite_vm.subprocess.Popen', return_value=Mock()) as popen:
                vm.launch()
            vm.stop()
            argv = popen.call_args_list[0].args[0]
            self.assertEqual(' '.join(argv).count('hostfwd='), 1)
            user = next(position for position, word in enumerate(argv) if word.startswith('user,'))
            self.assertEqual(argv[user - 1], '-netdev')

    def test_launch_returns_before_the_console_and_the_shell_follows_the_prompt(self):
        with tempfile.TemporaryDirectory() as directory:
            vm = self.unguest(directory)
            vm.port = 49152
            with patch('suite_vm.subprocess.Popen', return_value=Mock()):
                vm.launch()
            self.assertEqual(vm.boots, 1)
            vm.buf = b'Linux version ...\r\n'
            # Nothing on the console yet: the drain reads it until its time is up.
            with patch.object(vm, 'expect', side_effect=TimeoutError('guest serial timed out')) as expect:
                self.assertFalse(tailscale_boot.drain_console(vm, 0.05))
            self.assertEqual(expect.call_args_list[0].args[0], tailscale_boot.NO_MATCH)
            # The login prompt arrives: the drain reports it and leaves it consumed.
            with patch.object(vm, 'expect', side_effect=TimeoutError('guest serial timed out')):
                vm.buf += tailscale_boot.CONSOLE + b'\r\nlogin:'
                self.assertTrue(tailscale_boot.drain_console(vm, 0.05))
            self.assertEqual(vm.buf, b'\r\nlogin:')
            with patch.object(vm, 'expect', return_value=Mock()) as expect, patch.object(vm, 'command') as command:
                vm.shell()
            vm.stop()
            self.assertEqual(expect.call_args_list, [call(b':~#', 40)])
            command.assert_called_once_with('true')

    def test_the_image_receipt_never_fails_and_names_the_boot_links(self):
        vm = Mock()
        vm.command.return_value = (0, 'S80tailscale\ndigest a874f9fd10321e57b00660af11695618e23fb622bb1a40bcd0d366dad1340e56')
        self.assertEqual(tailscale_boot.image_receipt(vm), 'S80tailscale, init digest a874f9fd1032')
        vm.command.return_value = (0, 'S99tailscale\ndigest ')
        self.assertEqual(tailscale_boot.image_receipt(vm), 'S99tailscale, init digest absent')
        vm.command.return_value = (0, 'digest ')
        self.assertEqual(tailscale_boot.image_receipt(vm), 'no boot link, init digest absent')
        vm.command.side_effect = RuntimeError('no shell')
        self.assertIn('unreadable', tailscale_boot.image_receipt(vm))


if __name__ == '__main__':
    unittest.main()
