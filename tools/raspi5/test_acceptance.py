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
import unittest
from unittest.mock import Mock, patch

import acceptance
from archives import verified_archive
import boot_safety
import customer_fixture
import minimal_flows
import radio_suite
import run
from suite_vm import FLOWS_COMMITTED, Guest, external_path
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

    def receipt(self, request_id, count):
        return bytes((len(request_id) + 1, 254, 0)) + request_id + bytes((count,))

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
                            model.sendall(self.receipt(request_id, count))

                    waiting = worker.submit(reply)
                    air = radio_suite.Radio(host)
                    if count:
                        self.assertEqual(air.send(b'fixture'), count)
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
        vm.command.return_value = (0, 'match 81\nmatch 82\nmarked\nram 2')
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
        vm.command.return_value = (0, '')
        with host, model:
            with self.assertRaisesRegex(RuntimeError, 'valve downlink before receive window'):
                radio_suite.run_valve(vm, radio_suite.Radio(host), {radio_suite.VALVE: valve},
                                      lambda: model.sendall(command_wire))

    def test_model_delivery_without_concentratord_frame_fails(self):
        vm = Mock()
        vm.command.return_value = (0, 'marked\nram 0')
        with self.assertRaisesRegex(RuntimeError, 'Concentratord frames received=0'):
            radio_suite._radio_evidence(vm, 'fixture', 1)

    def test_unavailable_concentratord_log_fails(self):
        vm = Mock()
        vm.command.return_value = (1, 'match 4\nmarked')
        with self.assertRaisesRegex(RuntimeError, 'persistent log unreadable'):
            radio_suite._radio_evidence(vm, 'fixture', 4)

    def test_frames_without_crc_filter_do_not_count(self):
        vm = Mock()
        vm.command.return_value = (0, 'crc-filter-off')
        with self.assertRaisesRegex(RuntimeError, 'disable_crc_filter is not false'):
            radio_suite._radio_evidence(vm, 'fixture', 1)

    def test_positive_model_and_concentratord_counts_pass(self):
        vm = Mock()
        vm.command.return_value = (0, 'match 81\nmatch 82\nmarked\nram 0')
        self.assertEqual(radio_suite._radio_evidence(vm, 'fixture', 2),
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

    def join_fixture(self, arrivals):
        now = 0
        deadline = None
        air = Mock()
        valve = Mock(devnonce=1, app_eui=bytes(8))
        valve.join_request.side_effect = lambda: bytes([valve.devnonce])
        valve.uplink.return_value = b'data'
        valve.accept_join.return_value = {'devaddr': 0x0037032B}
        replies = iter(arrivals)

        def send(frame):
            nonlocal deadline
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

    def guest(self, frames=None, chirpstack=None):
        """A guest that answers markers, frame queries and ChirpStack queries.

        frames and chirpstack map an attempt number to the guest's output;
        attempts without an entry get a complete receipt.
        """
        scripts = []

        def command(script, timeout=None):
            scripts.append(script)
            attempt = sum('logger -t osi-radio-suite' in s for s in scripts)
            if 'logger -t osi-radio-suite' in script:
                return 0, ''
            if 'osi-radio-suite:' in script:
                return 0, (frames or {}).get(attempt, 'match 81\nmarked\nram 1')
            if 'device_keys' in script:
                return 0, (chirpstack or {}).get(attempt, '1 0037032B')
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
            f'{radio_suite.VALVE} join attempt 1/3 (DevNonce 1): received | '
            'frame: Concentratord uplink_id 81 at 902300000 Hz, 125000 Hz, SF7; '
            'chirpstack: ChirpStack DevNonce 1 recorded, DevAddr 0037032B; '
            'join-accept: join-accept after 5.00 s'))
        frame_query = next(s for s in scripts if 'osi-radio-suite:' in s)
        self.assertIn("-v freq='902300000' -v bw='125000' -v dr='SF7'", frame_query)
        chirpstack_query = next(s for s in scripts if 'device_keys' in s)
        self.assertIn(f"k.dev_eui = x'{radio_suite.VALVE}'", chirpstack_query)
        self.assertIn("lower(j.key) = '0000000000000000' AND n.value = 1", chirpstack_query)
        self.assertIn('-readonly', chirpstack_query)
        self.assertNotIn('app_key', chirpstack_query)
        valve.accept_join.assert_called_once()

    def assert_incomplete(self, missing, reason, **guest):
        air, valve, clock = self.join_fixture([5.0])
        vm, _ = self.guest(**guest)
        output = io.StringIO()
        with (patch.object(radio_suite.time, 'monotonic', clock), redirect_stdout(output),
              self.assertRaisesRegex(RuntimeError, 'incomplete join receipt') as raised):
            radio_suite.inject(vm, air, {radio_suite.VALVE: valve})
        line = output.getvalue().strip()
        self.assertIn(f'attempt 1/3 (DevNonce 1): missing {missing} |', line)
        self.assertIn(reason, line)
        self.assertIn(line, str(raised.exception))
        # A join-accept arrived, so a missing part is not retried.
        self.assertEqual(air.send.call_count, 1)
        valve.uplink.assert_not_called()

    def test_join_without_concentratord_frame_fails(self):
        self.assert_incomplete('frame', 'no Concentratord "Frame received" line after the attempt marker '
                                        'in the persistent log (RAM ring has 1)',
                               frames={1: 'marked\nram 1'})

    def test_join_frame_at_another_frequency_or_sf_fails(self):
        for channel in ('902500000 125000 SF7', '902300000 125000 SF8', '902300000 500000 SF7'):
            with self.subTest(channel=channel):
                self.assert_incomplete('frame', f'uplink_id 81 at freq/bw/dr {channel.replace(" ", "/")}, '
                                                'expected 902300000 Hz, 125000 Hz, SF7',
                                       frames={1: f'other 81 {channel}\nmarked\nram 0'})

    def test_join_frame_without_attempt_marker_fails(self):
        self.assert_incomplete('frame', 'attempt marker absent from the persistent log',
                               frames={1: 'match 81\nunmarked\nram 1'})

    def test_join_without_chirpstack_record_fails(self):
        self.assert_incomplete('chirpstack', 'ChirpStack has no DevNonce 1 recorded',
                               chirpstack={1: '0 0037032B'})

    def test_join_accept_from_another_join_fails(self):
        self.assert_incomplete('chirpstack', 'ChirpStack DevAddr 01E1EE61 differs from join-accept DevAddr 0037032B',
                               chirpstack={1: '1 01E1EE61'})

    def test_unreadable_chirpstack_database_fails(self):
        self.assert_incomplete('chirpstack', 'ChirpStack database unreadable', chirpstack={1: ''})

    def test_wrapped_join_drains_then_retries_with_fresh_devnonce(self):
        _, output, air, valve, scripts = self.run_join([139.31, 5.1])
        self.assertEqual([call.args[0] for call in air.send.call_args_list], [b'\x01', b'\x02', b'data'])
        self.assertEqual([round(call.args[0], 2) for call in air.receive.call_args_list], [40, 110, 40])
        valve.accept_join.assert_called_once()
        first, second = output.splitlines()
        self.assertIn('attempt 1/3 (DevNonce 1): missing join-accept |', first)
        self.assertIn('join-accept: MISSING (join-accept late after 139.31 s (drained))', first)
        self.assertIn('attempt 2/3 (DevNonce 2): received |', second)
        self.assertIn('join-accept after 5.10 s', second)
        chirpstack = [s for s in scripts if 'device_keys' in s]
        self.assertIn('n.value = 1)', chirpstack[0])
        self.assertIn('n.value = 2)', chirpstack[1])

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
            self.assertIn(f'attempt {attempt}/3 (DevNonce {attempt}): missing join-accept |', line)
            self.assertIn('join-accept: MISSING (join-accept absent after 150.00 s)', line)
        valve.accept_join.assert_not_called()

    def test_retry_requires_a_frame_for_its_own_join(self):
        air, valve, clock = self.join_fixture([139.31, 5.1])
        vm, scripts = self.guest(frames={2: 'marked\nram 0'})
        with (patch.object(radio_suite.time, 'monotonic', clock), redirect_stdout(io.StringIO()),
              self.assertRaisesRegex(RuntimeError, 'attempt 2/3 .*missing frame')):
            radio_suite.inject(vm, air, {radio_suite.VALVE: valve})
        first, second = [s.split()[-1] for s in scripts if 'logger -t osi-radio-suite' in s]
        self.assertNotEqual(first, second)
        queries = [s for s in scripts if 'osi-radio-suite:' in s]
        self.assertIn(f"marker='{first}'", queries[0])
        self.assertIn(f"marker='{second}'", queries[1])
        self.assertNotIn(first, queries[1])
        valve.uplink.assert_not_called()

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
            # One label and one count per line: no doubled "0" from `grep -c ... || echo 0`.
            persistent = diag.split('logread\n')[0].splitlines()[1:]
            for line in persistent:
                if not line.startswith('concentratord pid'):
                    self.assertRegex(line, r'^[^\d\n]+ \d+$')

    def test_frame_receipt_matches_the_syslog_tag_and_case_window(self):
        prefix = 'Sun Apr 13 16:45:33 2025 '
        marker = prefix + 'user.notice osi-radio-suite: fixture'
        daemon = ('chirpstack-concentratord-sx1302[51]: Frame received, uplink_id: 81, count_us: 154102266, '
                  'freq: 902300000, bw: 125000, mod: LoRa, dr: SF7, ftime_received: false, ftime_ns: 0')
        valid = prefix + 'user.info ' + daemon
        foreign = prefix + 'user.info unrelated[42]: printed ' + daemon
        with tempfile.TemporaryDirectory() as directory:
            root = Path(directory)
            (root/'concentratord.toml').write_text('disable_crc_filter=false\n')
            for current in ([foreign], [foreign, valid]):
                with self.subTest(has_frame=valid in current):
                    # The marker can sit in the rotated file.
                    (root/'osi-system.log.old').write_text(valid + '\n' + marker + '\n')
                    (root/'osi-system.log').write_text('\n'.join(current) + '\n')
                    vm = SimpleNamespace(command=lambda script: self.run_log_script(script, root, valid))
                    frames = radio_suite._concentratord_frames(vm, 'fixture')
                    if valid in current:
                        self.assertEqual(frames.matched, ['81'])
                        self.assertEqual(radio_suite._radio_evidence(vm, 'fixture', 1),
                                         'WM1302 model delivered=1, Concentratord frames received=1')
                    else:
                        self.assertEqual(frames.matched, [])
                        with self.assertRaisesRegex(RuntimeError, 'Concentratord frames received=0'):
                            radio_suite._radio_evidence(vm, 'fixture', 1)

    def test_frame_receipt_parses_channel_fields(self):
        prefix = 'Sun Apr 13 16:45:33 2025 user.'
        marker = prefix + 'notice osi-radio-suite: fixture'
        frame = (prefix + 'info chirpstack-concentratord-sx1302[51]: Frame received, uplink_id: {}, count_us: 1, '
                 'freq: {}, bw: {}, mod: LoRa, dr: {}, ftime_received: false, ftime_ns: 0')
        lines = [frame.format(80, 902300000, 125000, 'SF7'), marker,
                 frame.format(81, 902500000, 125000, 'SF7'), frame.format(82, 902300000, 125000, 'SF8'),
                 frame.format(83, 902300000, 125000, 'SF7'), frame.format(83, 902300000, 125000, 'SF7')]
        with tempfile.TemporaryDirectory() as directory:
            root = Path(directory)
            (root/'concentratord.toml').write_text('disable_crc_filter = false\n')
            (root/'osi-system.log').write_text('\n'.join(lines) + '\n')
            vm = SimpleNamespace(command=lambda script: self.run_log_script(script, root, ''))
            frames = radio_suite._concentratord_frames(vm, 'fixture')
        self.assertTrue(frames.marked)
        self.assertEqual(frames.matched, ['83'])
        self.assertEqual(frames.other, [('81', '902500000', '125000', 'SF7'), ('82', '902300000', '125000', 'SF8')])

    def test_frame_receipt_reads_only_the_persistent_log(self):
        prefix = 'Sun Apr 13 16:45:33 2025 user.'
        marker = prefix + 'notice osi-radio-suite: fixture'
        frame = (prefix + 'info chirpstack-concentratord-sx1302[51]: Frame received, uplink_id: {}, count_us: 1, '
                 'freq: 902300000, bw: 125000, mod: LoRa, dr: SF7, ftime_received: false, ftime_ns: 0')
        first, second = frame.format(81), frame.format(82)
        cases = (
            ('persistent log lags', [marker], [marker, first], [], 1),
            ('sinks overlap', [marker, first], [marker, first, second], ['81'], 2),
            ('RAM has no attempt marker', [marker], [first], [], 0),
        )
        with tempfile.TemporaryDirectory() as directory:
            root = Path(directory)
            (root/'concentratord.toml').write_text('disable_crc_filter=false\n')
            for name, persistent, ram, matched, ram_matched in cases:
                with self.subTest(name=name):
                    (root/'osi-system.log').write_text('\n'.join(persistent) + '\n')
                    vm = SimpleNamespace(command=lambda script: self.run_log_script(script, root, '\n'.join(ram)))
                    frames = radio_suite._concentratord_frames(vm, 'fixture')
                    self.assertEqual(frames.matched, matched)
                    self.assertEqual(frames.ram_matched, ram_matched)
                    _, missing = radio_suite._frame_part(frames)
                    if matched:
                        self.assertIsNone(missing)
                    else:
                        self.assertIn('in the persistent log', missing)

    def test_frame_receipt_requires_the_crc_filter(self):
        with tempfile.TemporaryDirectory() as directory:
            root = Path(directory)
            (root/'concentratord.toml').write_text('disable_crc_filter=true\n')
            (root/'osi-system.log').write_text('')
            vm = SimpleNamespace(command=lambda script: self.run_log_script(script, root, ''))
            self.assertIn('disable_crc_filter is not false', radio_suite._concentratord_frames(vm, 'fixture').error)

    @unittest.skipUnless(shutil.which('sqlite3'), 'sqlite3 CLI absent')
    def test_chirpstack_query_reads_devnonce_and_devaddr(self):
        # Table shapes and the dev_nonces JSON follow ChirpStack 4.12.1's SQLite schema.
        with tempfile.TemporaryDirectory() as directory:
            database = Path(directory)/'chirpstack.sqlite'
            with closing(sqlite3.connect(database)) as db:
                db.executescript("""
CREATE TABLE device (dev_eui blob not null primary key, dev_addr blob, join_eui blob not null);
CREATE TABLE device_keys (dev_eui blob not null primary key, nwk_key blob not null, app_key blob not null,
                          dev_nonces text not null, join_nonce int not null);
INSERT INTO device VALUES (x'A840410000000001', x'0037032B', x'0000000000000000');
INSERT INTO device VALUES (x'A840410000000002', NULL, x'0000000000000000');
INSERT INTO device_keys VALUES (x'A840410000000001', x'00', x'00', '{"0000000000000000":[1,2]}', 2);
INSERT INTO device_keys VALUES (x'A840410000000002', x'00', x'00', '{"0102030405060708":[1]}', 1);
""")

            def command(script, timeout=None):
                script = script.replace(radio_suite.CHIRPSTACK_DB, quote(str(database)))
                result = subprocess.run(['sh', '-c', script], capture_output=True, text=True)
                return result.returncode, result.stdout.strip()

            vm = SimpleNamespace(command=command)
            join = bytes(8).hex()
            self.assertEqual(radio_suite._chirpstack_join(vm, 'A840410000000001', join, 2), (True, '0037032B', None))
            self.assertEqual(radio_suite._chirpstack_join(vm, 'A840410000000001', join, 3), (False, '0037032B', None))
            self.assertEqual(radio_suite._chirpstack_join(vm, 'A840410000000002', join, 1), (False, None, None))
            self.assertEqual(radio_suite._chirpstack_join(vm, 'A840410000000003', join, 1), (False, None, None))
            database.unlink()
            self.assertEqual(radio_suite._chirpstack_join(vm, 'A840410000000001', join, 1),
                             (False, None, 'ChirpStack database unreadable'))


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
                      patch.object(acceptance, 'ready'), patch.object(acceptance, 'verify_disk') as disk,
                      patch.object(acceptance, 'build_media'), patch.object(acceptance, 'upgrade') as upgrade):
                    if fault == 'clone':
                        disk.side_effect = RuntimeError('clone failed')
                    self.assertEqual(acceptance.run_cases(args, root, root, root, 'minimal', False),
                                     int(fault != 'none'))
                derive_image.assert_called_once()
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


if __name__ == '__main__':
    unittest.main()
