"""Host-only tests for the Pi 5 acceptance runner."""
from concurrent.futures import ThreadPoolExecutor
from contextlib import ExitStack, closing, nullcontext, redirect_stderr, redirect_stdout
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
import boot_timing
import customer_fixture
import minimal_flows
import radio_suite
import run
import suite_vm
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
        """A stale receipt, another device's downlink and a MAC-only frame pass through; the open is taken in its window."""
        host, model = socket.socketpair()
        valve = Mock(devaddr=1, rx_delay=1)
        valve.uplink.side_effect = [b'trigger receive window', b'report opened']
        valve.downlink.return_value = {'fport': 2, 'payload': b'\x41\x01', 'fcnt': 1}
        command, command_wire = self.downlink(valve.devaddr)
        _, other_wire = self.downlink(2)
        _, mac_wire = self.downlink(valve.devaddr, port=0)
        replies = iter([(mac_wire + command_wire, self.valve_stamp(1)), (b'', self.valve_stamp(2))])
        output = io.StringIO()
        vm = self.answering({
            'frames()': [self.window(self.scheduled(1), 1), self.window('', 2)],
            'valve_actuation_expectations': ['', self.expectation_row('a56e55db', self.QUEUE),
                                            self.expectation_row('a56e55db', self.QUEUE)],
            'device_queue_item': [self.HELD, '']})
        with (host, model, ThreadPoolExecutor(1) as worker, redirect_stdout(output),
              patch.object(radio_suite, '_wait_history'), patch.object(radio_suite.time, 'sleep'),
              patch.object(radio_suite, 'sql', return_value='CLOSED'),
              patch.object(radio_suite, 'EARLY_WINDOW_TIMEOUT', 0.01)):
            model.settimeout(2)
            model.sendall(self.receipt(b'old-id!!', 1) + command_wire)

            def reply():
                with model.makefile('rb') as wire:
                    for extra, stamp in replies:
                        request_id, payload = self.request(wire)
                        model.sendall(extra + self.receipt(request_id, 1, stamp))

            waiting = worker.submit(reply)
            air = radio_suite.Radio(host)
            result = radio_suite.run_valve(vm, air, {radio_suite.VALVE: valve},
                                          lambda: model.sendall(other_wire + mac_wire))
            self.assertEqual(result, 'WM1302 model delivered=2, Concentratord frames received=2')
            self.assertFalse(air.buffer)
            valve.downlink.assert_called_once_with(command)
            waiting.result()
        self.assertEqual(len(output.getvalue().strip().splitlines()), 2)
        self.assertIn('downlink: open command FPort 2 payload 4101 FCnt 1 received after ', output.getvalue())

    def test_valve_command_after_gui_open_and_before_window_still_fails(self):
        """A downlink that arrives before the receive window fails the attempt, and its line names the frame."""
        host, model = socket.socketpair()
        valve = Mock(devaddr=1, rx_delay=1)
        valve.downlink.return_value = {'fport': 2, 'payload': b'\x41\x01', 'fcnt': 1}
        _, command_wire = self.downlink(valve.devaddr)
        output = io.StringIO()
        with (host, model, redirect_stdout(output), patch.object(radio_suite.time, 'sleep'),
              patch.object(radio_suite, 'sql', return_value='CLOSED'),
              self.assertRaisesRegex(RuntimeError, 'valve downlink before receive window: FPort 2 payload 4101 received '
                                      '[0-9.]+ s after the GUI open, before the receive window')):
            radio_suite.run_valve(self.answering({'valve_actuation_expectations': [''], 'device_queue_item': [self.HELD]}),
                                  radio_suite.Radio(host), {radio_suite.VALVE: valve}, lambda: model.sendall(command_wire))
        self.assertRegex(output.getvalue().strip(), '^' + re.escape(
            f'{radio_suite.VALVE} valve open attempt 1/3 (open, queue item -): failed: downlink before receive window | '
            'downlink: MISSING (FPort 2 payload 4101 received ') + r'[0-9]+\.[0-9]{2}' + re.escape(
            ' s after the GUI open, before the receive window)') + '$')

    VALVE_COUNT = 247517304
    QUEUE = '6f1c0b52-3a1e-4a62-9a53-2d9d0e0c1b7f'
    DOWNLINK = '3000953403'
    HELD = f'{QUEUE}|2|4101|0|0|'
    TAKEN = f'{QUEUE}|2|4101|0|0|1'
    NO_FRAME = 'marked\nclosed\nram 0'
    BINDS = (f'ChirpStack downlink {DOWNLINK}, ack ["OK", "IGNORED"]: Concentratord took it at RX1 +1 s with '
             '140.5 ms lead at enqueue; Scheduled packet for TX')
    REFUSED = (f'ChirpStack downlink {DOWNLINK}, ack ["TOO_LATE", "TOO_LATE"]: Concentratord refused it at RX1 +1 s: '
               'too late, 0.3 ms past its TX time; Concentratord refused it at RX2 +2 s: too late, 0.3 ms past its TX time')
    RUN = {'open': {'received_at': '2025-04-13T16:52:00.000Z'},
           'closed': {'received_at': '2025-04-13T16:52:59.000Z'}}
    SHORT_LEAD = (f'ChirpStack downlink {DOWNLINK}, ack ["TOO_LATE", "TOO_LATE"]: Concentratord refused it at RX1 +1 s: '
                  'too late, only 0.3 ms lead time; Concentratord refused it at RX2 +2 s: too late, 0.3 ms past its TX time')

    def command(self, downlink=DOWNLINK):
        """The forwarder's line for the downlink command ChirpStack sent."""
        return f'dl command {downlink}\n'

    def ack(self, *items, downlink=DOWNLINK):
        """The forwarder's line for the gateway's ack of that downlink."""
        return 'dl ack [' + ', '.join(f'"{item}"' for item in items) + f'], {downlink}\n'

    def slot(self, uplink, seconds=1):
        return self.valve_count(uplink) + seconds * 1000000

    def scheduled(self, uplink):
        """ChirpStack's downlink for the open: Concentratord took it 140.454 ms before RX1 and scheduled it."""
        slot = self.slot(uplink)
        return (self.command() + f'dl enqueue {self.DOWNLINK} {slot} {slot - 140454}\ndl tx {self.DOWNLINK} {slot} -\n'
                + self.ack('OK', 'IGNORED'))

    def refused(self, uplink):
        """ChirpStack's downlink for the open: Concentratord refused it in both receive slots."""
        first, second = self.slot(uplink), self.slot(uplink, 2)
        return (self.command() + f'dl too-late {self.DOWNLINK} {first} {first + 300}\n'
                f'dl too-late {self.DOWNLINK} {second} {second + 300}\n' + self.ack('TOO_LATE', 'TOO_LATE'))

    def short_lead(self, uplink):
        """ChirpStack's downlink for the open: RX1 refused for want of lead, RX2 refused as past."""
        first, second = self.slot(uplink), self.slot(uplink, 2)
        return (self.command() + f'dl too-late {self.DOWNLINK} {first} {first - 300}\n'
                f'dl too-late {self.DOWNLINK} {second} {second + 300}\n' + self.ack('TOO_LATE', 'TOO_LATE'))

    def valve_stamp(self, uplink):
        """The 32 MHz stamp the model gives the valve case's n-th uplink; stamp / 32 is its count_us."""
        return self.valve_count(uplink) % (1 << 27) * 32

    def valve_count(self, uplink):
        """count_us of the valve case's n-th uplink: 30 ms apart, so each stamp binds one frame."""
        return self.VALVE_COUNT + 30000 * (uplink - 1)

    def expectation_row(self, identifier, queue_id, phase='ACCEPTED', report=None, f_port=2, payload='4101'):
        """One valve_actuation_expectations row as the edge query returns it."""
        transport = {'phase': phase,
                     'effect_snapshot': {'fPort': f_port, 'bytes_hex': payload, 'encoded_duration_seconds': 60}}
        if queue_id is not None:
            transport.update(queue_id=queue_id, accepted_at='2025-04-13T16:49:14.498Z')
        if report is not None:
            transport['untrusted_report'] = report
        return f'{identifier}|PENDING_OBSERVATION|||' + json.dumps(transport).encode().hex()

    def reported(self, identifier, queue_id):
        """The same row after the edge attached its OPEN and CLOSED reports."""
        return self.expectation_row(identifier, queue_id, report=self.RUN)

    @staticmethod
    def answer(value):
        return value if isinstance(value, tuple) else (0, value)

    def answering(self, reads):
        """A guest whose marker reads succeed and whose other reads come from the lists, in call order."""
        reads = {needle: iter(answers) for needle, answers in reads.items()}

        def command(script, timeout=None):
            if '# attempt-marker' in script:
                return 0, '5 0'
            for needle, answers in reads.items():
                if needle in script:
                    return self.answer(next(answers))
            raise AssertionError('unexpected guest command')

        return SimpleNamespace(command=command)

    def window(self, events='', *uplinks):
        """A closed window with one bound frame per uplink: its send number, or (send number, uplink ID)."""
        return ''.join(f'match {uplink[1] if isinstance(uplink, tuple) else 80 + uplink} '
                       f'{self.valve_count(uplink[0] if isinstance(uplink, tuple) else uplink)}\n'
                       for uplink in uplinks or (1,)) + events + self.CLOSED

    def valve_fixture(self, arrivals, *, payload=b'\x41\x01', fport=2, wire_port=2, rx_delay=1,
                      frames=(), edges=(), held=(), after=(), raise_on=None):
        """A valve and its guest.

        arrivals holds one list of delays after each trigger uplink, in
        seconds. Each attempt marker arms the next ChirpStack queue read, the
        one before the trigger, which draws on held; every later one draws on
        after. frames and edges answer the window and edge reads in call
        order. The radio clock advances by every receive timeout, so a wrap
        139.31 s after the uplink costs the 40 s window and 109.31 s of drain.
        """
        now, pending, armed, last = 0, [], [False], [None]
        air, valve = Mock(), Mock(devaddr=1, rx_delay=rx_delay)
        arrivals, sends = iter(arrivals), iter(range(1, 1000))
        held, after, windows, rows = iter(held), iter(after), iter(frames), iter(edges)

        def uplink(frame, *_args, **_keywords):
            if frame != radio_suite.STREGA:
                last[0] = 'opened'
                return b'opened'
            kind = 'closed' if last[0] == 'opened' else 'trigger'
            last[0] = kind
            return kind.encode()

        def send(frame):
            nonlocal pending
            air.last_stamp = self.valve_stamp(next(sends))
            if frame == b'trigger':
                pending = [None if delay is None else now + delay for delay in next(arrivals, [])]
            return 1

        def receive(timeout, matches):
            nonlocal now, pending
            if pending and pending[0] is not None and pending[0] <= now + timeout:
                now, pending = pending[0], pending[1:]
                packet = self.downlink(1, port=wire_port)[0]
                self.assertTrue(matches(packet))
                return packet
            now += timeout
            raise TimeoutError

        def command(script, timeout=None):
            if raise_on is not None and raise_on(script):
                raise RuntimeError('guest serial closed')
            if '# attempt-marker' in script:
                armed[0] = True
                return 0, '5 0'
            if 'frames()' in script:
                return self.answer(next(windows, self.CLOSED))
            if 'valve_actuation_expectations' in script:
                return self.answer(next(rows, ''))
            if 'device_queue_item' in script:
                if armed[0]:
                    armed[0] = False
                    return self.answer(next(held, ''))
                return self.answer(next(after, ''))
            raise AssertionError('unexpected guest command')

        air.send.side_effect, air.receive.side_effect = send, receive
        valve.uplink.side_effect = uplink
        valve.downlink.return_value = {'fport': fport, 'payload': payload, 'fcnt': 1}
        return air, valve, SimpleNamespace(command=command), lambda: now

    def valve_case(self, arrivals, *, error=None, frames=(), edges=(), held=(), after=(), gui=None, downlink=None,
                   waits=None, sql=None, payload=b'\x41\x01', fport=2, wire_port=2, rx_delay=1, send=None,
                   raise_on=None):
        """Run the valve case against the fixture; collect what it logged even when it fails.

        error is the message the case must fail with, as a substring. waits
        sees each gateway query through a patched _wait_history, and the valve
        then reports CLOSED before its open report. sql instead answers the
        real polls of _wait_history and the state reads.
        """
        air, valve, vm, clock = self.valve_fixture(
            arrivals, payload=payload, fport=fport, wire_port=wire_port, rx_delay=rx_delay, frames=frames, edges=edges,
            held=held, after=after, raise_on=raise_on)
        if send is not None:
            air.send.side_effect = send
        gui_open = Mock(side_effect=gui) if gui is not None else Mock()
        if downlink is not None:
            valve.downlink.side_effect = downlink
        output, raised, waiting = io.StringIO(), None, Mock(side_effect=waits)
        patcher = patch.object(radio_suite, '_wait_history', waiting) if sql is None else nullcontext()
        with (patch.object(radio_suite.time, 'monotonic', clock), patch.object(radio_suite.time, 'sleep') as sleep,
              redirect_stdout(output), patcher,
              patch.object(radio_suite, 'sql', sql) if sql is not None else
              patch.object(radio_suite, 'sql', return_value='CLOSED')):
            try:
                result = radio_suite.run_valve(vm, air, {radio_suite.VALVE: valve}, gui_open)
            except RuntimeError as exception:
                if error is None:
                    raise
                if isinstance(error, re.Pattern):
                    self.assertRegex(str(exception), error)
                else:
                    self.assertIn(error, str(exception))
                raised, result = exception, None
        if error is not None and raised is None:
            self.fail(f'the valve case passed where "{error}" was expected')
        return SimpleNamespace(result=result, error=raised, lines=output.getvalue().strip().splitlines(),
                               air=air, valve=valve, gui_open=gui_open, clock=clock, waits=waiting, sleep=sleep)

    def sent(self, case):
        return [call.args[0] for call in case.air.send.call_args_list]

    def timeouts(self, case):
        return [round(call.args[0], 2) for call in case.air.receive.call_args_list]

    def query(self, identifier, kind, bound=False):
        """The evidence query for one expectation, as run_valve writes it."""
        return radio_suite._expectation_evidence(identifier, kind, 60 if bound else None)

    def reissue(self, **changes):
        """A wrap on the first open, then a second open on time; edges and frames as the guest answers them."""
        setup = dict(
            arrivals=[[139.31], [1.0]],
            frames=[self.window(self.scheduled(1), 1), self.window('', 2, 3), self.window(self.scheduled(4), 4), self.window('', 5)],
            edges=['', self.expectation_row('e1', self.QUEUE), self.reported('e1', self.QUEUE), self.reported('e1', self.QUEUE),
                   self.reported('e1', self.QUEUE) + '\n' + self.expectation_row('e2', 'q2'),
                   self.reported('e1', self.QUEUE) + '\n' + self.expectation_row('e2', 'q2')],
            held=[self.HELD, 'q2|2|4101|0|0|'], after=['', ''])
        return self.valve_case(**{**setup, **changes})

    def test_valve_receipt_names_the_queue_item_and_the_scheduling_line(self):
        """One delivered open, as in the 0.8.4 diagnostic run: frame, item, queue, decision and arrival in one line."""
        row = self.expectation_row('e1', self.QUEUE)
        case = self.valve_case([[1.0]], frames=[self.window(self.scheduled(1), (1, 1902493660)), self.window('', (2, 1902493661))],
                               edges=['', row], held=[self.HELD], after=[''])
        self.assertEqual(case.lines, [
            f'{radio_suite.VALVE} valve open attempt 1/3 (open, queue item {self.QUEUE}): received | '
            f'edge: queue item {self.QUEUE} ACCEPTED at 2025-04-13T16:49:14.498Z, FPort 2 payload 4101; '
            f'queued: ChirpStack holds queue item {self.QUEUE} next before the receive window: FPort 2 payload 4101 is_pending 0 is_encrypted 0; '
            'model: WM1302 model delivered=1; downlink: open command FPort 2 payload 4101 FCnt 1 received after 1.00 s; '
            f'frame: Concentratord uplink_id 1902493660 (count_us {self.VALVE_COUNT}) at 902300000 Hz, 125000 Hz, SF7, '
            f'model stamp {self.valve_stamp(1)}; concentratord: {self.BINDS}; '
            'queue after: ChirpStack queue after the attempt: empty',
            f'{radio_suite.VALVE} valve open report of attempt 1 (expectation e1, sent {radio_suite.UPLINK}): '
            f'Concentratord uplink_id 1902493661 (count_us {self.valve_count(2)}) at 902300000 Hz, 125000 Hz, SF7, '
            f'model stamp {self.valve_stamp(2)}'])
        self.assertEqual(case.result, 'WM1302 model delivered=2, Concentratord frames received=2')
        case.gui_open.assert_called_once()
        self.assertEqual(self.sent(case), [b'trigger', b'opened'])
        self.assertEqual([call.args[1:] for call in case.waits.call_args_list], [
            (radio_suite.VALVE_STATE, 'OPEN'), (self.query('e1', 'open', bound=True), 'yes')])

    def test_wrapped_valve_downlink_drains_then_reissues_the_open(self):
        """The 0.8.4 failure: scheduled with 140.5 ms lead, delivered one wrap late, then a second open on time.

        The late open is reported over before the second open, and the outcome
        is read on the second attempt's own expectation.
        """
        order = []
        case = self.reissue(gui=lambda: order.append('gui'),
                            waits=lambda _vm, query, _expected: order.append(query))
        self.assertEqual(case.result, 'WM1302 model delivered=5, Concentratord frames received=5; '
                         'passed on attempt 2/3 after 1 retry (attempt 1: open command late after 139.31 s (drained); '
                         f'{self.BINDS}); 1 late open reported over before a re-issue')
        self.assertEqual(case.gui_open.call_count, 2)
        self.assertEqual(self.sent(case), [b'trigger', b'opened', b'closed', b'trigger', b'opened'])
        self.assertEqual(self.timeouts(case), [2, 40, 110, 10.69, 2, 40])
        self.assertEqual(case.air.begin_case.call_count, 2)
        self.assertIn(f'attempt 1/3 (open, queue item {self.QUEUE}): missing downlink | ', case.lines[0])
        self.assertIn('downlink: MISSING (open command late after 139.31 s (drained))', case.lines[0])
        self.assertIn(f'attempt 2/3 (open, queue item q2): received | edge: queue item q2 ACCEPTED', case.lines[2])
        self.assertIn(f'{radio_suite.VALVE} earlier open e1, delivered late on attempt 1: reported open, closed after 60 s | ',
                      case.lines[1])
        self.assertIn(f'report 1: Concentratord uplink_id 82 (count_us {self.valve_count(2)}) at 902300000 Hz, 125000 Hz, '
                      f'SF7, model stamp {self.valve_stamp(2)}; report 2: Concentratord uplink_id 83 (count_us '
                      f'{self.valve_count(3)}) at 902300000 Hz, 125000 Hz, SF7, model stamp {self.valve_stamp(3)}', case.lines[1])
        self.assertIn(f'valve open report of attempt 2 (expectation e2, sent {radio_suite.UPLINK}): Concentratord uplink_id 85',
                      case.lines[3])
        self.assertAlmostEqual(case.sleep.call_args.args[0], 49.31, places=2)
        self.assertEqual([call.args[1:] for call in case.waits.call_args_list], [
            (self.query('e1', 'open'), 'yes'), (self.query('e1', 'closed'), 'yes'), (radio_suite.VALVE_STATE, 'CLOSED'),
            (radio_suite.VALVE_STATE, 'OPEN'), (self.query('e2', 'open', bound=True), 'yes')])
        first_open = order.index(self.query('e1', 'open'))
        second_open = order.index('gui', order.index('gui') + 1)
        self.assertLess(first_open, order.index(self.query('e1', 'closed')))
        self.assertLess(order.index(self.query('e1', 'closed')), second_open)
        self.assertIn("expectation_id='e2' AND upper(device_eui)='" + radio_suite.VALVE + "' AND commanded_duration_seconds=60;",
                      self.query('e2', 'open', bound=True))

    def test_second_late_copy_is_drained_and_validated_before_the_retry(self):
        """Both receive slots wrap: both copies are decoded, and both leave the socket before the retry."""
        case = self.reissue(arrivals=[[139.31, 140.31], [1.0]])
        self.assertEqual(self.timeouts(case), [2, 40, 110, 10.69, 9.69, 2, 40])
        self.assertEqual(self.sent(case), [b'trigger', b'opened', b'closed', b'trigger', b'opened'])
        self.assertIn('downlink: MISSING (open command late after 139.31 s (drained with 1 later copy))', case.lines[0])
        self.assertEqual(case.valve.downlink.call_count, 3)

    def test_open_whose_queue_item_stays_at_chirpstack_is_resent_without_a_new_open(self):
        """ChirpStack refused nothing to send but keeps the item: the next uplink alone gets the same item delivered."""
        row = self.expectation_row('e1', self.QUEUE)
        case = self.valve_case(
            [[None], [1.0]],
            frames=[self.window(self.short_lead(1), 1), self.window(self.scheduled(2), 2), self.window('', 3)],
            edges=['', row, row, row], held=[self.HELD, self.TAKEN], after=[self.TAKEN, ''])
        self.assertEqual(case.result, 'WM1302 model delivered=3, Concentratord frames received=3; '
                         'passed on attempt 2/3 after 1 retry (attempt 1: open command absent after 150.00 s; '
                         f'{self.SHORT_LEAD})')
        case.gui_open.assert_called_once()
        self.assertEqual(self.timeouts(case), [2, 40, 110, 40])
        self.assertEqual(self.sent(case), [b'trigger', b'trigger', b'opened'])
        self.assertIn(f'attempt 2/3 (resend, queue item {self.QUEUE}): received | ', case.lines[1])
        self.assertIn(f'queue after: ChirpStack queue after the attempt: item {self.QUEUE} FPort 2 data 4101 is_pending 0 '
                      'is_encrypted 0 f_cnt_down 1', case.lines[0])
        self.assertIn(f'queued: ChirpStack holds queue item {self.QUEUE} next before the receive window: FPort 2 payload 4101 '
                      'is_pending 0 is_encrypted 0 f_cnt_down 1; ', case.lines[1])
        self.assertEqual([call.args[1:] for call in case.waits.call_args_list], [
            (radio_suite.VALVE_STATE, 'OPEN'), (self.query('e1', 'open', bound=True), 'yes')])

    def test_open_command_concentratord_refuses_still_fails_after_the_resends(self):
        """A refusal on the first window earns one re-send; a refusal on the re-send fails the case with its receipt."""
        row = self.expectation_row('e1', self.QUEUE)
        case = self.valve_case(
            [[None]] * 3, error=f'the re-send of queue item {self.QUEUE} on attempt 2 missed: open command absent '
                                f'after 150.00 s; {self.REFUSED}. A miss on a re-send is no ground for another attempt',
            frames=[self.window(self.refused(n), n) for n in (1, 2, 3)], edges=['', row, row, row],
            held=[self.HELD, self.TAKEN, self.TAKEN], after=[self.TAKEN] * 3)
        case.gui_open.assert_called_once()
        self.assertEqual(self.sent(case), [b'trigger'] * 2)
        self.assertEqual(case.clock(), 152 + 150)
        self.assertEqual(len(case.lines), 2)
        for number, line in enumerate(case.lines, 1):
            kind = 'open' if number == 1 else 'resend'
            self.assertIn(f'attempt {number}/3 ({kind}, queue item {self.QUEUE}): missing downlink | ', line)
            self.assertIn(f'concentratord: {self.REFUSED}', line)

    def test_three_wrapped_opens_fail_after_the_bounded_attempts(self):
        """Three late deliveries in a row end the case after the third, each earlier open reported over first."""
        e1, e2, e3 = (self.expectation_row(name, item) for name, item in (('e1', self.QUEUE), ('e2', 'q2'), ('e3', 'q3')))
        r1, r2, r3 = (self.reported(name, item) for name, item in (('e1', self.QUEUE), ('e2', 'q2'), ('e3', 'q3')))
        case = self.valve_case(
            [[139.31]] * 3, error='open command not received after 3 attempts',
            frames=[self.window(self.scheduled(1), 1), self.window('', 2, 3), self.window(self.scheduled(4), 4),
                    self.window('', 5, 6), self.window(self.scheduled(7), 7), self.window('', 8, 9)],
            edges=['', e1, r1, r1, r1 + '\n' + e2, r1 + '\n' + r2, r1 + '\n' + r2, r1 + '\n' + r2 + '\n' + e3,
                   r1 + '\n' + r2 + '\n' + r3],
            held=[self.HELD, 'q2|2|4101|0|0|', 'q3|2|4101|0|0|'], after=[''] * 3)
        self.assertEqual(case.gui_open.call_count, 3)
        self.assertEqual(self.sent(case), [b'trigger', b'opened', b'closed'] * 3)
        attempts = [line for line in case.lines if ' valve open attempt ' in line]
        self.assertEqual([line.split('): ')[1].split(' | ')[0] for line in attempts], ['missing downlink'] * 3)
        self.assertEqual(len(case.lines), 6)

    def test_open_command_chirpstack_never_emits_fails_at_once(self):
        """No downlink in any receive slot is not a wrap: the case fails on the first attempt and is not retried."""
        row = self.expectation_row('e1', self.QUEUE)
        case = self.valve_case(
            [[None], [1.0]], error='no open-command downlink logged; the attempt is not credited',
            frames=[self.window()], edges=['', row, row, row], held=[self.HELD], after=[''])
        case.gui_open.assert_called_once()
        self.assertEqual(self.sent(case), [b'trigger'])
        self.assertEqual(len(case.lines), 1)
        self.assertIn('concentratord: no open-command downlink logged; queue after: ChirpStack queue after the attempt: empty',
                      case.lines[0])

    def test_unscheduled_open_cannot_pass_on_a_reissue(self):
        """The review probe: a fresh accepted item, no scheduled downlink, an unrelated item left in the queue."""
        first, second = self.expectation_row('e1', 'q1'), self.expectation_row('e2', 'q2')
        case = self.valve_case(
            [[None], [1.0]], error='no open-command downlink logged; the attempt is not credited',
            frames=[self.window('', 1), self.window(self.scheduled(2), 2), self.window('', 3)],
            edges=['', first, first, first + '\n' + second], held=['q1|2|4101|0|0|'], after=['old|3|4101|0|0|'])
        case.gui_open.assert_called_once()
        self.assertEqual(self.sent(case), [b'trigger'])
        self.assertIn('queue after: ChirpStack queue after the attempt: item old FPort 3 data 4101 is_pending 0 is_encrypted 0',
                      case.lines[0])

    def test_open_that_leaves_chirpstack_without_a_decision_is_a_loss_and_is_not_reissued(self):
        """Scheduled for TX but never received: consumed and unaccountable, so a second open would go unattributed."""
        row = self.expectation_row('e1', self.QUEUE)
        case = self.valve_case(
            [[None], [1.0]],
            error=f'open command lost: {self.BINDS}; it never reached the model and ChirpStack has '
            'consumed it, so its expectation stays pending and a second open could not be attributed',
            frames=[self.window(self.scheduled(1), 1)], edges=['', row, row, row], held=[self.HELD], after=[''])
        case.gui_open.assert_called_once()
        self.assertEqual(self.sent(case), [b'trigger'])
        self.assertIn('downlink: MISSING (open command absent after 150.00 s)', case.lines[0])

    def test_late_open_command_with_another_payload_fails(self):
        """A drained frame is decoded: it must be the queued command, whatever its timing."""
        row = self.expectation_row('e1', self.QUEUE)
        reason = 'FPort 2 payload 4102 is not the queued command FPort 2 payload 4101'
        case = self.valve_case(
            [[139.31], [1.0]], error='late open command failed verification: ' + reason, payload=b'\x41\x02',
            frames=[self.window(self.scheduled(1), 1)], edges=['', row, row, row], held=[self.HELD], after=[''])
        case.gui_open.assert_called_once()
        self.assertEqual(self.sent(case), [b'trigger'])
        self.assertIn(f'attempt 1/3 (open, queue item {self.QUEUE}): failed: late downlink: {reason} | ', case.lines[0])
        self.assertIn(f'downlink: MISSING ({reason}, drained as late copy 1)', case.lines[0])

    def test_late_open_command_that_fails_its_mic_fails(self):
        row = self.expectation_row('e1', self.QUEUE)
        case = self.valve_case(
            [[139.31], [1.0]], error='late open command failed verification: a downlink that failed verification',
            frames=[self.window(self.scheduled(1), 1)], edges=['', row, row, row], held=[self.HELD], after=[''],
            downlink=ValueError('downlink MIC mismatch'))
        self.assertEqual(self.sent(case), [b'trigger'])
        self.assertIn('downlink: MISSING (a downlink that failed verification (downlink MIC mismatch), '
                      'drained as late copy 1)', case.lines[0])

    def test_open_on_another_port_fails_instead_of_timing_out(self):
        """An accepted command on the wrong port reaches the valve: it is decoded and refused, not filtered out."""
        row = self.expectation_row('e1', self.QUEUE)
        reason = 'FPort 3 payload 4101 is not the queued command FPort 2 payload 4101'
        case = self.valve_case(
            [[1.0], [1.0]], error='timed-open downlink payload mismatch: ' + reason, fport=3, wire_port=3,
            frames=[self.window(self.scheduled(1), 1)], edges=['', row], held=[self.HELD], after=[''])
        case.gui_open.assert_called_once()
        self.assertEqual(self.sent(case), [b'trigger'])
        self.assertIn(f'failed: downlink: {reason} | ', case.lines[0])
        self.assertIn(f'downlink: MISSING ({reason}, received 1.00 s after the uplink)', case.lines[0])

    def test_any_application_port_is_taken_off_the_socket_and_decoded(self):
        """The receive filter takes every application port, so a wrong one is seen; FPort 0 and other devices pass."""
        takes = radio_suite._valve_data(7)
        self.assertEqual((takes(self.downlink(7)[0]), takes(self.downlink(7, port=3)[0])),
                         (True, True))
        self.assertEqual((takes(self.downlink(7, port=0)[0]), takes(self.downlink(8)[0])), (False, False))

    def test_open_is_not_injected_unless_chirpstack_holds_the_exact_command(self):
        """The edge's item must be in ChirpStack's queue, as the timed open, before the uplink goes out."""
        row = self.expectation_row('e1', self.QUEUE)
        foreign = f'other|2|4101|0|0|'
        cases = (
            ('', f'ChirpStack does not hold queue item {self.QUEUE} before the receive window: empty'),
            (foreign, f'ChirpStack does not hold queue item {self.QUEUE} before the receive window: '
                       'item other FPort 2 data 4101 is_pending 0 is_encrypted 0'),
            (f'{self.QUEUE}|2', 'ChirpStack database unreadable'),
            (f'{self.QUEUE}|2|4101|0', 'ChirpStack database unreadable'),
            (f'{self.QUEUE}|3|4101|0|0|', f'ChirpStack holds queue item {self.QUEUE} as FPort 3 payload 4101, '
                                          'not the queued FPort 2 payload 4101'),
            (f'{self.QUEUE}|2|4102|0|0|', f'ChirpStack holds queue item {self.QUEUE} as FPort 2 payload 4102, '
                                          'not the queued FPort 2 payload 4101'),
            (f'{self.QUEUE}|2|4101|0|1|', f'ChirpStack holds queue item {self.QUEUE} encrypted (is_encrypted 1), '
                                          'so its plaintext cannot be checked'),
            (f'{self.QUEUE}|2|4101|1|0|', f'ChirpStack holds queue item {self.QUEUE} pending an earlier transmission '
                                          '(is_pending 1)'),
            (f'{foreign}\n{self.HELD}', f'ChirpStack holds queue item {self.QUEUE}, but queue item other is next '
                                        'for the device, and ChirpStack sends the first item of the queue'),
        )
        for answer, reason in cases:
            with self.subTest(reason=reason):
                case = self.valve_case([[1.0], [1.0]], error=reason + '; no uplink was sent', edges=['', row], held=[answer])
                self.assertEqual(self.sent(case), [])
                self.assertEqual(len(case.lines), 1)
                self.assertIn(f'attempt 1/3 (open, queue item {self.QUEUE}): missing queued | ', case.lines[0])
                self.assertIn(f'queued: MISSING ({reason})', case.lines[0])

    def test_open_the_edge_queued_as_another_command_is_not_injected(self):
        """The edge's own effect snapshot must name the timed open."""
        for f_port, payload in ((3, '4101'), (2, '4102')):
            with self.subTest(f_port=f_port, payload=payload):
                row = self.expectation_row('e1', self.QUEUE, f_port=f_port, payload=payload)
                case = self.valve_case(
                    [[1.0]], error=f'the edge queued FPort {f_port} payload {payload} for the one-minute open, '
                    'not FPort 2 payload 4101; no uplink was sent', edges=['', row], held=[self.HELD])
                self.assertEqual(self.sent(case), [])
                self.assertIn(f'missing edge | edge: MISSING (the edge queued FPort {f_port} payload {payload} for the '
                              'one-minute open', case.lines[0])

    def test_receive_slots_follow_the_session_delay(self):
        """RX1 opens RXDelay1 seconds after the uplink, as the join-accept told the valve; RX2 one second later."""
        self.assertEqual(radio_suite.rx_delays(SimpleNamespace(rx_delay=0)), (1000000, 2000000))
        self.assertEqual(radio_suite.rx_delays(SimpleNamespace(rx_delay=3)), (3000000, 4000000))
        row = self.expectation_row('e1', self.QUEUE)
        case = self.valve_case(
            [[3.0]], rx_delay=3, edges=['', row], held=[self.HELD], after=[''],
            frames=[self.window(self.command('9') + 'dl enqueue 9 250517304 250376850\ndl tx 9 250517304 -\n'
                                   + self.ack('OK', 'IGNORED', downlink='9'), 1), self.window('', 2)])
        self.assertEqual(case.result, 'WM1302 model delivered=2, Concentratord frames received=2')
        self.assertIn('concentratord: ChirpStack downlink 9, ack ["OK", "IGNORED"]: Concentratord took it at RX1 +3 s '
                      'with 140.5 ms lead at enqueue; Scheduled packet for TX', case.lines[0])

    def test_a_session_without_a_receive_delay_is_diagnosed(self):
        """No RXDelay1 in the session: named before anything is sent, not replaced by one second."""
        for session in (SimpleNamespace(), SimpleNamespace(rx_delay='1'), SimpleNamespace(rx_delay=-1),
                        SimpleNamespace(rx_delay=True)):
            with self.subTest(session=session), self.assertRaisesRegex(ValueError, 'no RXDelay1'):
                radio_suite.rx_delays(session)
        row = self.expectation_row('e1', self.QUEUE)
        refused = 'the session carries no RXDelay1 (rx_delay None), so its receive slots cannot be placed'
        case = self.valve_case([[1.0]], rx_delay=None, error=refused, edges=['', row], held=[self.HELD])
        case.gui_open.assert_not_called()
        self.assertEqual(case.lines, [f'{radio_suite.VALVE} valve open attempt 1/3 (open, queue item -): '
                                     f'failed: session: {refused}'])

    def test_a_downlink_taken_outside_the_session_slots_is_named_and_not_credited(self):
        """ChirpStack's downlink, taken outside RX1 and RX2: named with its offset, and the attempt is not retried."""
        row = self.expectation_row('e1', self.QUEUE)
        case = self.valve_case(
            [[None], [1.0]],
            frames=[self.window(self.command('9') + 'dl enqueue 9 251517304 251400000\n'
                                   + self.ack('OK', 'IGNORED', downlink='9'), 1), self.window(self.scheduled(2), 2),
                    self.window('', 3)],
            error='ChirpStack downlink 9, ack ["OK", "IGNORED"]: Concentratord took it +4 s after the frame, outside '
                  "this session's RX1 at +1 s and RX2 at +2 s (unsupported or unknown RX timing); the attempt is not credited",
            edges=['', row, row, row], held=[self.HELD, self.HELD], after=['', ''])
        case.gui_open.assert_called_once()
        self.assertEqual(self.sent(case), [b'trigger'])
        self.assertEqual(case.valve.downlink.call_count, 0)

    def test_unknown_rx_timing_fails_even_when_the_command_arrived_on_time(self):
        """Review r2 probe, inverted: a TX outside the session's slots is not credited on a delivery."""
        row = self.expectation_row('e1', self.QUEUE)
        case = self.valve_case(
            [[1.0]], error=f'no ChirpStack downlink command in the window; Concentratord logged downlink IDs 9, none '
                           f'bound to queue item {self.QUEUE}; the attempt is not credited',
            frames=[self.window('dl tx 9 252517304 -\n', 1), self.window('', 2)],
            edges=['', row], held=[self.HELD], after=[''])
        self.assertEqual(self.sent(case), [b'trigger'])

    def test_downlink_fate_reports_the_lead_at_enqueue_and_follows_the_schedule(self):
        """Concentratord's scheduling line, with the lead it had, wrap-safe, and only for this downlink."""
        def frame(count, current, sent=True, downlink='7'):
            events = [radio_suite.Downlink('enqueue', downlink, count, current)]
            return radio_suite.Frames(downlinks=events + [radio_suite.Downlink('tx', downlink, count, None)] if sent else [])
        fate = radio_suite._downlink_fate
        scheduled = 'Concentratord scheduled the open command for TX (downlink_id 7)'
        self.assertEqual(fate(frame(248517304, 248376850), 248517304, 'open command', lead=True),
                         scheduled + ' with 140.5 ms lead at enqueue')
        self.assertEqual(fate(frame(100, 4294967200), 100, 'open command', lead=True),
                         scheduled + ' with 0.2 ms lead at enqueue')
        self.assertEqual(fate(frame(200, 300), 200, 'open command', lead=True),
                         scheduled + ' with 0.1 ms past its TX time at enqueue')
        self.assertEqual(fate(frame(248517304, 248376850), 248517304, 'open command'), scheduled)
        self.assertIsNone(fate(frame(248517304, 248376850, sent=False), 248517304, 'open command', lead=True))
        self.assertIsNone(fate(frame(248517304, 248376850), 248517305, 'open command', lead=True))

    def test_binding_names_each_step_for_one_downlink(self):
        """RX1 refused for want of lead, RX2 taken and scheduled: each step is named for the one ChirpStack downlink."""
        count, delays = 247517304, (1000000, 2000000)
        bind = radio_suite._bind_downlink
        kept = radio_suite.QueueItem('q1', '2', '4101', '0', '0', '1')
        refused = radio_suite.Downlink('too-late', '3000953403', count + 1000000, count + 1000000 - 300)
        taken = [radio_suite.Downlink('enqueue', '3000953403', count + 2000000, count + 20000),
                 radio_suite.Downlink('tx', '3000953403', count + 2000000, None)]
        self.assertEqual(
            bind(radio_suite.Frames(downlinks=[*taken, refused], commands=['3000953403'],
                                    acks=[('["IGNORED", "OK"]', '3000953403')]), count, delays, 'q1', None),
            radio_suite.Binding('ChirpStack downlink 3000953403, ack ["IGNORED", "OK"]: Concentratord refused it at '
                               'RX1 +1 s: too late, only 0.3 ms lead time; Concentratord took it at RX2 +2 s with 1980.0 ms lead at '
                               'enqueue; Scheduled packet for TX', True, True))
        self.assertEqual(
            bind(radio_suite.Frames(downlinks=taken, commands=['3000953403'],
                                    acks=[('["OK", "IGNORED"]', '3000953403')]), count, delays, 'q1', kept),
            radio_suite.Binding('ChirpStack downlink 3000953403, ack ["OK", "IGNORED"]: Concentratord took it at RX2 +2 s '
                               'with 1980.0 ms lead at enqueue; Scheduled packet for TX; the gateway acked OK but '
                               "ChirpStack still holds queue item q1", False, True))
        dropped = [radio_suite.Downlink('enqueue', '3000953403', count + 1000000, count + 1000000 - 140454),
                   radio_suite.Downlink('too-old', '-', count + 1000000, count + 1000000 + 19900)]
        self.assertEqual(
            bind(radio_suite.Frames(downlinks=dropped, commands=['3000953403']), count, delays, 'q1', None).text,
            'ChirpStack downlink 3000953403, ack not logged: Concentratord took it at RX1 +1 s with 140.5 ms lead at '
            'enqueue; Concentratord dropped a packet at RX1 +1 s as too old, 19.9 ms after its TX time; the line names '
            'no downlink ID, so it is no decision for this one; no TX or refusal logged for it; queue item q1 left '
            'ChirpStack\'s queue without an OK ack')
        across = [radio_suite.Downlink('enqueue', '3000953403', count + 1000000, count + 1000000 - 140454),
                  radio_suite.Downlink('tx', '3000953403', count + 2000000, None)]
        self.assertEqual(
            bind(radio_suite.Frames(downlinks=across, commands=['3000953403'],
                                    acks=[('["OK", "IGNORED"]', '3000953403')]), count, delays, 'q1', None),
            radio_suite.Binding('ChirpStack downlink 3000953403, ack ["OK", "IGNORED"]: Concentratord took it at RX1 +1 s '
                               'with 140.5 ms lead at enqueue; Scheduled packet for TX at RX2 +2 s, where it was not '
                               'enqueued; no TX or refusal logged for it', False, True))
        self.assertEqual(bind(radio_suite.Frames(commands=['7']), None, delays, 'q1', kept).text,
                         'ChirpStack downlink 7, ack not logged: no Concentratord frame to place the receive slots')
        too_far = [radio_suite.Downlink('tx', '7', count - 2000000, None),
                   radio_suite.Downlink('too-old', '-', count + 5000000 - (1 << 32), count + 1)]
        self.assertEqual(bind(radio_suite.Frames(downlinks=too_far), count, delays, 'q1', kept).text,
                         'no ChirpStack downlink command in the window; Concentratord logged downlink IDs 7, '
                         'none bound to queue item q1')

    def join_accept(self, rxdelay):
        """A join-accept on the wire for a fixed key, as the network sends it: the plain block AES-decrypted."""
        from lorawan import _aes, _cmac
        key = bytes(range(16))
        settings = b'\x01\x02\x03\x04\x05\x06' + (7).to_bytes(4, 'little') + bytes([0, rxdelay])
        block = settings + _cmac(key, b'\x20' + settings)[:4]
        decrypt = ("const c=require('node:crypto'),i=require('fs').readFileSync(0);"
                   "const d=c.createDecipheriv('aes-128-ecb',i.subarray(0,16),null);d.setAutoPadding(false);"
                   "process.stdout.write(Buffer.concat([d.update(i.subarray(16)),d.final()]));")
        wire = subprocess.run(['node', '-e', decrypt], input=key + block, capture_output=True, check=True).stdout
        self.assertEqual(_aes(key, wire), block)
        return b'\x20' + wire

    def test_join_accept_keeps_the_receive_delay(self):
        """The session keeps RXDelay1 from the join-accept (0 means 1 s); the valve slots follow it."""
        from lorawan import LoRaWAN10
        session = LoRaWAN10(bytes(8), bytes.fromhex('A840410000000001'), bytes(range(16)), devnonce=1)
        fields = session.accept_join(self.join_accept(3))
        self.assertEqual((fields['rx_delay'], session.rx_delay, radio_suite.rx_delays(session)),
                         (3, 3, (3000000, 4000000)))
        session = LoRaWAN10(bytes(8), bytes.fromhex('A840410000000002'), bytes(range(16)), devnonce=1)
        session.accept_join(self.join_accept(0))
        self.assertEqual((session.rx_delay, radio_suite.rx_delays(session)), (0, (1000000, 2000000)))

    def test_valve_attempt_missing_its_frame_or_edge_part_fails_before_a_retry(self):
        """A timeout without Concentratord's frame is not retried; an open with no new expectation sends nothing."""
        row = self.expectation_row('e1', self.QUEUE)
        no_frame = self.valve_case(
            [[None], [1.0]], error='incomplete valve receipt: frame', frames=[self.NO_FRAME],
            edges=['', row, row, row], held=[self.HELD], after=[''])
        self.assertIn(f'attempt 1/3 (open, queue item {self.QUEUE}): missing downlink, frame | ', no_frame.lines[0])
        self.assertIn('frame: MISSING (no Concentratord "Frame received" line in the attempt window of the persistent log)',
                      no_frame.lines[0])
        foreign_frame = self.valve_case(
            [[None], [1.0]], error='incomplete valve receipt: frame',
            frames=['match 99 200000000\n' + self.CLOSED], edges=['', row, row, row], held=[self.HELD], after=[''])
        self.assertIn('missing downlink, frame | ', foreign_frame.lines[0])
        self.assertIn('frame: MISSING (no Concentratord frame carries the model stamp '
                      f'{self.valve_stamp(1)} (count_us {self.valve_stamp(1) // 32 % (1 << 27)} mod 2^27, less up to '
                      '20000 us); frames at 902300000 Hz, 125000 Hz, SF7: uplink_id 99 (count_us 200000000))',
                      foreign_frame.lines[0])
        no_expectation = self.valve_case(
            [[None], [1.0]], error='the edge recorded no new valve expectation for the open; no uplink was sent',
            edges=['', ''], held=[self.HELD])
        self.assertIn(f'attempt 1/3 (open, queue item -): missing edge | ', no_expectation.lines[0])
        self.assertIn('edge: MISSING (the edge recorded no new valve expectation for the open)', no_expectation.lines[0])
        for case in (no_frame, foreign_frame):
            case.gui_open.assert_called_once()
            self.assertEqual(self.sent(case), [b'trigger'])
            self.assertEqual(case.clock(), 152)
        no_expectation.gui_open.assert_called_once()
        self.assertEqual(self.sent(no_expectation), [])

    def test_older_expectation_cannot_stand_in_for_a_new_open(self):
        """An open that added no expectation is missing its edge part, although older rows exist."""
        older = self.expectation_row('e0', 'q0')
        case = self.valve_case(
            [[None], [1.0]], error='the edge recorded no new valve expectation for the open; no uplink was sent',
            edges=[older, older], held=[self.HELD])
        self.assertIn('missing edge | ', case.lines[0])
        case.gui_open.assert_called_once()
        self.assertEqual(self.sent(case), [])

    def test_open_attempt_whose_edge_transport_was_not_accepted_fails_before_the_uplink(self):
        row = self.expectation_row('e1', None, phase='ATTEMPTED')
        case = self.valve_case(
            [[None], [1.0]], error='the edge transport phase is ATTEMPTED with no queue item; no uplink was sent',
            edges=['', row], held=[self.HELD])
        self.assertIn('missing edge | ', case.lines[0])
        self.assertIn('edge: MISSING (the edge transport phase is ATTEMPTED with no queue item)', case.lines[0])
        case.gui_open.assert_called_once()
        self.assertEqual(self.sent(case), [])

    def test_reissued_open_that_the_gui_refuses_names_the_attempt(self):
        opens = []

        def second_open_refused():
            opens.append(1)
            if len(opens) == 2:
                raise RuntimeError('GUI open check failed')

        case = self.reissue(gui=second_open_refused, error='open attempt 2/3: GUI open check failed')
        self.assertEqual(self.sent(case), [b'trigger', b'opened', b'closed'])
        self.assertEqual(case.lines[2], f'{radio_suite.VALVE} valve open attempt 2/3 (open, queue item -): '
                                        'failed: gui: GUI open check failed')

    def test_open_report_missing_from_the_concentratord_log_fails(self):
        """The frame that carries the open state needs its own receipt."""
        row = self.expectation_row('e1', self.QUEUE)
        case = self.valve_case(
            [[1.0]], error='incomplete open report receipt: no Concentratord "Frame received" line',
            frames=[self.window(self.scheduled(1), 1), self.NO_FRAME], edges=['', row], held=[self.HELD], after=[''])
        self.assertEqual(len(case.lines), 1)
        self.assertEqual(self.sent(case), [b'trigger', b'opened'])

    def test_valve_window_errors_fail_the_case_before_a_retry(self):
        row = self.expectation_row('e1', self.QUEUE)
        for answer, reason in (((0, 'crc-filter-off'), 'disable_crc_filter is not false'),
                               ((1, ''), 'persistent log unreadable'),
                               ((0, 'marked\nram 0'), 'end marker did not reach the persistent log within 10 s'),
                               ((0, 'rotated-away'), 'persistent log rotated past the attempt marker')):
            with self.subTest(reason=reason):
                case = self.valve_case(
                    [[None], [1.0]], error='incomplete valve receipt: frame: ' + reason,
                    frames=[answer], edges=['', row, row, row], held=[self.HELD], after=[''])
                self.assertEqual(self.sent(case), [b'trigger'])

    def test_reissue_waits_for_the_edge_to_report_the_earlier_open(self):
        """Without the edge attaching the first OPEN report, no second open is issued."""
        def refusing(_vm, query, _expected):
            if "expectation_id='e1'" in query and '$.untrusted_report.open' in query:
                raise RuntimeError('decoded observation absent from gateway history')
        case = self.reissue(waits=refusing, error='the earlier open e1 is not reported over: its OPEN report was not '
                                                  'attached to it')
        case.gui_open.assert_called_once()
        self.assertEqual(self.sent(case), [b'trigger', b'opened'])
        self.assertEqual(case.sleep.call_count, 0)

    def test_reissue_waits_for_the_edge_to_attach_the_earlier_closed_report(self):
        """Without the edge attaching the first CLOSED report, no second open is issued either."""
        def refusing(_vm, query, _expected):
            if "expectation_id='e1'" in query and '$.untrusted_report.closed' in query:
                raise RuntimeError('decoded observation absent from gateway history')
        case = self.reissue(waits=refusing, error='the earlier open e1 is not reported over: its CLOSED report was not '
                                                  'attached to it')
        case.gui_open.assert_called_once()
        self.assertEqual(self.sent(case), [b'trigger', b'opened', b'closed'])

    def test_reissue_requires_the_edge_to_hold_the_earlier_open_closed(self):
        """The earlier expectation must carry both reports before the next open goes out."""
        e1 = self.expectation_row('e1', self.QUEUE)
        half = self.expectation_row('e1', self.QUEUE, report={'open': self.RUN['open']})
        case = self.reissue(edges=['', e1, half, half],
                            error='the earlier open e1 does not hold both reports after they were sent')
        case.gui_open.assert_called_once()
        self.assertEqual(self.sent(case), [b'trigger', b'opened', b'closed'])

    def test_report_and_outcome_are_bound_to_the_successful_attempt(self):
        """With real polls: the second attempt's expectation is asked for its own OPEN report, and gets it."""
        states = iter(['CLOSED', 'CLOSED', 'OPEN'])

        def sql(_vm, query):
            if query == radio_suite.VALVE_STATE:
                return next(states, 'OPEN')
            if "expectation_id='e1'" in query or (
                    "expectation_id='e2'" in query and 'commanded_duration_seconds=60' in query):
                return 'yes'
            raise AssertionError(f'unexpected query {query}')

        case = self.reissue(sql=sql)
        self.assertEqual(self.sent(case), [b'trigger', b'opened', b'closed', b'trigger', b'opened'])
        self.assertIn('passed on attempt 2/3 after 1 retry', case.result)

    def test_evidence_attached_to_the_earlier_row_does_not_pass(self):
        """With real polls: the first row's reports do not stand in for the second attempt's expectation."""
        states = iter(['CLOSED', 'CLOSED', 'OPEN'])

        def sql(_vm, query):
            if query == radio_suite.VALVE_STATE:
                return next(states, 'OPEN')
            if "expectation_id='e1'" in query:
                return 'yes'
            if 'commanded_duration_seconds=60 AND (observed_open_at' in query:
                return 'yes'
            if "expectation_id='e2'" in query:
                return ''
            raise AssertionError(f'unexpected query {query}')

        case = self.reissue(sql=sql, error='the expectation of attempt 2 (e2) holds no OPEN report')
        self.assertEqual(self.sent(case), [b'trigger', b'opened', b'closed', b'trigger', b'opened'])
        self.assertNotIn('passed on attempt 2/3', ' '.join(case.lines))

    def test_the_earlier_open_must_stand_unchanged_through_the_successful_attempt(self):
        """Evidence moved onto the earlier row while the second open was reported fails the case, and the line names the value."""
        row = self.expectation_row('e1', self.QUEUE)
        moved = self.expectation_row('e1', self.QUEUE,
                                    report={**self.RUN, 'open': {'received_at': '2026-04-13T16:53:00.000Z'}})
        case = self.reissue(
            edges=['', row, self.reported('e1', self.QUEUE), self.reported('e1', self.QUEUE),
                   self.reported('e1', self.QUEUE) + '\n' + self.expectation_row('e2', 'q2'),
                   moved + '\n' + self.reported('e2', 'q2')],
            error="the earlier open e1 changed while attempt 2 was reported: report: ")
        self.assertEqual(self.sent(case), [b'trigger', b'opened', b'closed', b'trigger', b'opened'])

    def test_the_earlier_expectation_must_stand_unchanged_trusted_timestamps_included(self):
        """Review r2 probe, inverted: the earlier row's observed_open_at moving by one second fails the case."""
        row = self.expectation_row('e1', self.QUEUE)
        closed = self.reported('e1', self.QUEUE).replace('|||', '|2025-04-13T16:52:00Z|2025-04-13T16:53:00Z|')
        altered = closed.replace('16:52:00Z', '16:52:01Z')
        second, second_reported = self.expectation_row('e2', 'q2'), self.reported('e2', 'q2')
        case = self.reissue(
            edges=['', row, closed, closed, closed + '\n' + second, altered + '\n' + second_reported],
            error="the earlier open e1 changed while attempt 2 was reported: open_at: '2025-04-13T16:52:00Z' -> "
                  "'2025-04-13T16:52:01Z'")
        self.assertEqual(self.sent(case), [b'trigger', b'opened', b'closed', b'trigger', b'opened'])

    def test_earlier_trusted_timestamps_that_stand_are_accepted(self):
        closed = self.reported('e1', self.QUEUE).replace('|||', '|2025-04-13T16:52:00Z|2025-04-13T16:53:00Z|')
        second, second_reported = self.expectation_row('e2', 'q2'), self.reported('e2', 'q2')
        case = self.reissue(edges=['', self.expectation_row('e1', self.QUEUE), closed, closed, closed + '\n' + second,
                                  closed + '\n' + second_reported])
        self.assertIn('passed on attempt 2/3 after 1 retry', case.result)
        settled = closed.replace('|PENDING_OBSERVATION|', '|OBSERVED_COMPLETE|')
        case = self.reissue(edges=['', self.expectation_row('e1', self.QUEUE), closed, closed, closed + '\n' + second,
                                  settled + '\n' + second_reported])
        self.assertIn('passed on attempt 2/3 after 1 retry', case.result)

    def test_successful_report_must_follow_a_closed_valve(self):
        """An OPEN state that predates the successful attempt's report is not that attempt's outcome."""
        row = self.expectation_row('e1', self.QUEUE)
        case = self.valve_case(
            [[1.0]], error='the valve reported OPEN before the open report of attempt 1', edges=['', row],
            held=[self.HELD], after=[''], frames=[self.window(self.scheduled(1), 1)], sql=lambda _vm, query: 'OPEN')
        self.assertEqual(self.sent(case), [b'trigger'])

    def test_every_outcome_logs_an_attempt_receipt(self):
        """A refused GUI open, a refused model uplink and a wrong payload each leave their line."""
        row = self.expectation_row('e1', self.QUEUE)
        refused = self.valve_case([[1.0]], gui=RuntimeError('GUI open check failed'), error='open attempt 1/3: GUI open check failed',
                                  edges=['', row], held=[self.HELD])
        self.assertEqual(refused.lines, [f'{radio_suite.VALVE} valve open attempt 1/3 (open, queue item -): '
                                         'failed: gui: GUI open check failed'])
        fifo = 'WM1302 model delivered zero frames (uplink rejected by RX FIFO)'
        rejected = self.valve_case(
            [[1.0]], error=fifo, send=RuntimeError(fifo), edges=['', row], held=[self.HELD])
        self.assertEqual(rejected.lines, [(
            f'{radio_suite.VALVE} valve open attempt 1/3 (open, queue item {self.QUEUE}): failed: model: {fifo} | '
            f'edge: queue item {self.QUEUE} ACCEPTED at 2025-04-13T16:49:14.498Z, FPort 2 payload 4101; '
            f'queued: ChirpStack holds queue item {self.QUEUE} next before the receive window: FPort 2 payload 4101 is_pending 0 is_encrypted 0; '
            f'model: MISSING ({fifo})')])
        self.assertEqual(rejected.air.receive.call_count, 1)

    def test_unrelated_decision_cannot_authorize_a_retry(self):
        """Review r2 probe, inverted: a foreign enqueue and TX while the item stays queued fails at once."""
        row = self.expectation_row('e1', self.QUEUE)
        foreign_tx = 'dl enqueue 7 248517304 248376850\ndl tx 99 248517304 -\n'
        case = self.valve_case(
            [[None], [1.0]], error='no ChirpStack downlink command in the window; Concentratord logged downlink IDs 7, 99, '
                                  f'none bound to queue item {self.QUEUE}; the attempt is not credited',
            frames=[self.window(foreign_tx, 1), self.window(self.scheduled(2), 2), self.window('', 3)],
            edges=['', row, row], held=[self.HELD, self.HELD], after=[self.HELD, ''])
        case.gui_open.assert_called_once()
        self.assertEqual(self.sent(case), [b'trigger'])
        self.assertIn('concentratord: no ChirpStack downlink command in the window; Concentratord logged downlink IDs 7, 99, '
                      f'none bound to queue item {self.QUEUE}', case.lines[0])
        self.assertIn('queue after: ChirpStack queue after the attempt: item ' + self.QUEUE + ' FPort 2 data 4101 '
                      'is_pending 0 is_encrypted 0', case.lines[0])

    def test_a_complete_unrelated_pair_cannot_authorize_a_retry(self):
        """Enqueue and TX that agree with each other and with ChirpStack's downlink, yet the item stays queued: not credited."""
        row = self.expectation_row('e1', self.QUEUE)
        slot = self.slot(1)
        pair = (self.command('99') + f'dl enqueue 99 {slot} {slot - 140454}\ndl tx 99 {slot} -\n'
                + self.ack('OK', 'IGNORED', downlink='99'))
        case = self.valve_case(
            [[None], [1.0]], error=f'the gateway acked OK but ChirpStack still holds queue item {self.QUEUE}; '
                                  'the attempt is not credited',
            frames=[self.window(pair, 1), self.window(self.scheduled(2), 2), self.window('', 3)],
            edges=['', row, row], held=[self.HELD, self.HELD], after=[self.HELD, ''])
        case.gui_open.assert_called_once()
        self.assertEqual(self.sent(case), [b'trigger'])

    def test_a_refused_downlink_the_item_was_never_built_into_is_not_credited(self):
        """A consistent command, refusal and ack chain, but ChirpStack never wrote f_cnt_down on the item: not its downlink."""
        row = self.expectation_row('e1', self.QUEUE)
        slot, later = self.slot(1), self.slot(1, 2)
        refused = (self.command('99') + f'dl too-late 99 {slot} {slot + 300}\ndl too-late 99 {later} {later + 300}\n'
                   + self.ack('TOO_LATE', 'TOO_LATE', downlink='99'))
        case = self.valve_case(
            [[None], [1.0]], error=f'ChirpStack still holds queue item {self.QUEUE} with no f_cnt_down, so it built no '
                                  'downlink from it; the attempt is not credited',
            frames=[self.window(refused, 1), self.window(self.scheduled(2), 2), self.window('', 3)],
            edges=['', row, row], held=[self.HELD, self.HELD], after=[self.HELD, ''])
        case.gui_open.assert_called_once()
        self.assertEqual(self.sent(case), [b'trigger'])
        built = self.valve_case(
            [[None], [1.0]], frames=[self.window(refused, 1), self.window(self.scheduled(2), 2), self.window('', 3)],
            edges=['', row, row, row], held=[self.HELD, self.TAKEN], after=[self.TAKEN, ''])
        self.assertIn('passed on attempt 2/3 after 1 retry', built.result)

    def test_an_on_time_delivery_bound_outside_the_session_slots_fails(self):
        """Review r2 probe with the full chain: the bound downlink went out at +5 s for a 1 s session, delivered on time."""
        row = self.expectation_row('e1', self.QUEUE)
        slot = self.slot(1, 5)
        chain = (self.command('9') + f'dl enqueue 9 {slot} {slot - 140454}\ndl tx 9 {slot} -\n'
                 + self.ack('OK', 'IGNORED', downlink='9'))
        case = self.valve_case(
            [[1.0]], error='ChirpStack downlink 9, ack ["OK", "IGNORED"]: Concentratord took it +5 s after the frame, '
                           "outside this session's RX1 at +1 s and RX2 at +2 s (unsupported or unknown RX timing); "
                           'the attempt is not credited',
            frames=[self.window(chain, 1), self.window('', 2)], edges=['', row], held=[self.HELD], after=[''])
        self.assertEqual(self.sent(case), [b'trigger'])
        far = self.slot(1, 40)
        beyond = self.valve_case(
            [[None], [1.0]], error='Concentratord took it +40 s after the frame',
            frames=[self.window(self.command('9') + f'dl enqueue 9 {far} {far - 140454}\ndl tx 9 {far} -\n'
                                + self.ack('OK', 'IGNORED', downlink='9'), 1)],
            edges=['', row, row], held=[self.HELD], after=[''])
        self.assertEqual(self.sent(beyond), [b'trigger'])

    def test_report_evidence_is_read_from_the_top_level_keys_only(self):
        """A trusted time or a top-level OPEN or CLOSED object is evidence; the same key nested deeper is not."""
        expectation = radio_suite.Expectation
        nested = expectation('e1', 'PENDING_OBSERVATION', report=json.dumps({'closed': {'open': {}}}, sort_keys=True))
        self.assertEqual((nested.open_evidence, nested.close_evidence), (False, True))
        self.assertEqual((expectation('e1', 'X', open_at='2025-04-13T16:52:00Z').open_evidence,
                          expectation('e1', 'X', report='{"open": "text"}').open_evidence), (True, False))

    def test_a_decision_for_another_downlink_is_not_credited(self):
        """ChirpStack's downlink was never taken by Concentratord; the enqueue and TX in its slot are another downlink's."""
        row = self.expectation_row('e1', self.QUEUE)
        slot = self.slot(1)
        other = (self.command('7') + f'dl enqueue 99 {slot} {slot - 140454}\ndl tx 99 {slot} -\n'
                 + self.ack('TOO_LATE', 'TOO_LATE', downlink='7'))
        case = self.valve_case(
            [[None], [1.0]], error='ChirpStack downlink 7, ack ["TOO_LATE", "TOO_LATE"]: Concentratord logged no enqueue '
                                  'for it in RX1 +1 s or RX2 +2 s; its decisions are for downlink IDs 99; '
                                  'the attempt is not credited',
            frames=[self.window(other, 1), self.window(self.scheduled(2), 2), self.window('', 3)],
            edges=['', row, row], held=[self.HELD, self.HELD], after=[self.HELD, ''])
        case.gui_open.assert_called_once()
        self.assertEqual(self.sent(case), [b'trigger'])

    def test_two_chirpstack_downlinks_in_the_window_bind_neither(self):
        """Two downlink commands in one window: neither can be named as the one built for the attempt's item."""
        row = self.expectation_row('e1', self.QUEUE)
        slot = self.slot(1)
        pair = f'dl enqueue 99 {slot} {slot - 140454}\ndl tx 99 {slot} -\n' + self.ack('OK', 'IGNORED', downlink='99')
        case = self.valve_case(
            [[None], [1.0]], error='2 ChirpStack downlink commands in the window (7, 99); none can be bound to queue item '
                                  f'{self.QUEUE}; the attempt is not credited',
            frames=[self.window(self.command('7') + self.command('99') + pair, 1), self.window(self.scheduled(2), 2),
                    self.window('', 3)],
            edges=['', row, row], held=[self.HELD, self.HELD], after=[self.HELD, ''])
        case.gui_open.assert_called_once()
        self.assertEqual(self.sent(case), [b'trigger'])

    def test_a_taken_downlink_without_a_decision_is_not_credited(self):
        """ChirpStack's downlink was taken, but Concentratord logged no TX, refusal or drop for it."""
        row = self.expectation_row('e1', self.QUEUE)
        slot = self.slot(1)
        taken = self.command() + f'dl enqueue {self.DOWNLINK} {slot} {slot - 140454}\n' + self.ack('OK', 'IGNORED')
        case = self.valve_case(
            [[None], [1.0]], error=f'ChirpStack downlink {self.DOWNLINK}, ack ["OK", "IGNORED"]: Concentratord took it at '
                                  'RX1 +1 s with 140.5 ms lead at enqueue; no TX or refusal logged for it; '
                                  'the attempt is not credited',
            frames=[self.window(taken, 1), self.window(self.scheduled(2), 2), self.window('', 3)],
            edges=['', row, row], held=[self.HELD, self.HELD], after=['', ''])
        case.gui_open.assert_called_once()
        self.assertEqual(self.sent(case), [b'trigger'])

    def test_a_resent_frame_must_carry_the_counter_chirpstack_recorded_for_the_item(self):
        """On a re-send the delivered frame's FCnt is the one ChirpStack wrote on the item for that delivery."""
        row = self.expectation_row('e1', self.QUEUE)
        case = self.valve_case(
            [[None], [1.0]], error="timed-open downlink frame counter mismatch: the delivered frame's FCnt 1 is not "
                                  f'f_cnt_down 2, which ChirpStack recorded for queue item {self.QUEUE}',
            frames=[self.window(self.short_lead(1), 1), self.window(self.scheduled(2), 2), self.window('', 3)],
            edges=['', row, row, row], held=[self.HELD, f'{self.QUEUE}|2|4101|0|0|2'], after=[self.TAKEN, ''])
        case.gui_open.assert_called_once()
        self.assertEqual(self.sent(case), [b'trigger', b'trigger'])
        self.assertIn('failed: downlink: the delivered frame\'s FCnt 1 is not f_cnt_down 2', case.lines[1])

    def test_a_resent_frame_is_compared_on_the_counter_bits_the_wire_carries(self):
        """f_cnt_down above 16 bits: the wire carries its low 16 bits, so FCnt 1 is counter 65537 and not counter 65538."""
        row = self.expectation_row('e1', self.QUEUE)
        for recorded, error in ((65537, None),
                               (65538, "timed-open downlink frame counter mismatch: the delivered frame's FCnt 1 is not "
                                       'f_cnt_down 65538')):
            with self.subTest(recorded=recorded):
                case = self.valve_case(
                    [[None], [1.0]], error=error,
                    frames=[self.window(self.short_lead(1), 1), self.window(self.scheduled(2), 2), self.window('', 3)],
                    edges=['', row, row, row], held=[self.HELD, f'{self.QUEUE}|2|4101|0|0|{recorded}'],
                    after=[self.TAKEN, ''])
                self.assertEqual(self.sent(case), [b'trigger', b'trigger'] + ([] if error else [b'opened']))
                self.assertIn(f'is_encrypted 0 f_cnt_down {recorded}; ', case.lines[1])

    def test_a_late_copy_is_held_to_the_counter_chirpstack_recorded_too(self):
        """A re-sent copy that drains late is checked against the recorded counter like one that arrives on time."""
        row = self.expectation_row('e1', self.QUEUE)
        reason = (f"the delivered frame's FCnt 1 is not f_cnt_down 2, which ChirpStack recorded for queue item {self.QUEUE}")
        case = self.valve_case(
            [[None], [139.31]], error='late open command failed verification: ' + reason,
            frames=[self.window(self.short_lead(1), 1), self.window(self.scheduled(2), 2)],
            edges=['', row, row], held=[self.HELD, f'{self.QUEUE}|2|4101|0|0|2'], after=[self.TAKEN, ''])
        self.assertEqual(self.sent(case), [b'trigger', b'trigger'])
        self.assertIn(f'failed: late downlink: {reason} | ', case.lines[1])
        self.assertIn(f'downlink: MISSING ({reason}, drained as late copy 1)', case.lines[1])

    def test_failed_baseline_read_leaves_a_receipt(self):
        """A console exception while reading the expectations before the open is logged as the attempt's failure."""
        air, valve, vm, clock = self.valve_fixture(
            [[1.0]], raise_on=lambda script: 'valve_actuation_expectations' in script)
        output = io.StringIO()
        with (patch.object(radio_suite.time, 'monotonic', clock), patch.object(radio_suite.time, 'sleep'),
              redirect_stdout(output), self.assertRaisesRegex(RuntimeError, 'guest serial closed')):
            radio_suite.run_valve(vm, air, {radio_suite.VALVE: valve}, Mock())
        self.assertEqual(output.getvalue().strip(), (
            f'{radio_suite.VALVE} valve open attempt 1/3 (open, queue item -): failed: RuntimeError: guest serial closed'))

    def test_an_unreadable_baseline_sends_nothing_and_is_logged(self):
        """The edge database answering with an error before the open: nothing is sent, and the receipt says why."""
        case = self.valve_case(
            [[1.0]], error="the edge's expectations could not be read before the open (edge database unreadable); "
                           'no uplink was sent', edges=[(1, '')], held=[self.HELD])
        case.gui_open.assert_not_called()
        self.assertEqual(self.sent(case), [])
        self.assertEqual(case.lines, [f'{radio_suite.VALVE} valve open attempt 1/3 (open, queue item -): '
                                     'missing edge before | edge before: MISSING (edge database unreadable)'])

    def test_any_other_item_left_queued_after_a_delivery_fails_the_case(self):
        """Review r3 probe, inverted: a second open, or any other item, behind the delivered one fails the case."""
        row = self.expectation_row('e1', self.QUEUE)
        for extra in ('dup|2|4101|0|0|', 'old|3|4101|0|0|'):
            with self.subTest(extra=extra):
                item = extra.split('|')
                case = self.valve_case(
                    [[1.0]], error=f'the open was delivered, but ChirpStack still holds item {item[0]} FPort {item[1]} '
                                   'data 4101 is_pending 0 is_encrypted 0 for the valve, which the next uplink would deliver',
                    edges=['', row], held=[self.HELD + '\n' + extra], after=[extra],
                    frames=[self.window(self.scheduled(1), 1), self.window('', 2)])
                self.assertEqual(self.sent(case), [b'trigger'])

    def test_a_fresh_item_that_already_carries_a_counter_is_not_injected(self):
        """Review r3 probe, inverted: a fresh item with f_cnt_down written before the uplink sends nothing."""
        row = self.expectation_row('e1', self.QUEUE)
        foreign = self.refused(1).replace(self.DOWNLINK, '99')
        case = self.valve_case(
            [[None], [1.0]], error=f'ChirpStack holds the fresh queue item {self.QUEUE} with f_cnt_down 1 already written, '
                                   'so a downlink built from it in this window could not be told from an earlier one; '
                                   'no uplink was sent',
            frames=[self.window(foreign, 1), self.window(self.scheduled(2), 2), self.window('', 3)],
            edges=['', row, row, row], held=[self.TAKEN, self.TAKEN], after=[self.TAKEN, ''])
        self.assertEqual(self.sent(case), [])

    def test_a_missed_resend_is_no_ground_for_another_attempt(self):
        """Review r3 probes, inverted: a foreign refusal, or a foreign TX without an ack, on the re-send fails the case."""
        row = self.expectation_row('e1', self.QUEUE)
        slot = self.slot(2)
        foreign = {'refusal': self.refused(2).replace(self.DOWNLINK, '99'),
                   'tx without ack': self.command('99') + f'dl enqueue 99 {slot} {slot - 140454}\ndl tx 99 {slot} -\n'}
        for name, events in foreign.items():
            with self.subTest(name=name):
                case = self.valve_case(
                    [[None], [None], [1.0]],
                    error=f'the re-send of queue item {self.QUEUE} on attempt 2 missed: open command absent after 150.00 s; '
                          'ChirpStack downlink 99',
                    frames=[self.window(self.refused(1), 1), self.window(events, 2), self.window(self.scheduled(3), 3),
                            self.window('', 4)],
                    edges=['', row, row, row], held=[self.HELD, self.TAKEN, self.TAKEN], after=[self.TAKEN, self.TAKEN, ''])
                self.assertEqual(self.sent(case), [b'trigger', b'trigger'])
                case.gui_open.assert_called_once()

    def test_a_resend_delivered_late_still_leads_to_a_reissue(self):
        """A late, authenticated delivery on the re-send is a genuine late delivery: reported over, then a fresh open."""
        row, reported = self.expectation_row('e1', self.QUEUE), self.reported('e1', self.QUEUE)
        second, second_reported = self.expectation_row('e2', 'q2'), self.reported('e2', 'q2')
        case = self.valve_case(
            [[None], [139.31], [1.0]],
            frames=[self.window(self.refused(1), 1), self.window(self.scheduled(2), 2), self.window('', 3, 4),
                    self.window(self.scheduled(5), 5), self.window('', 6)],
            edges=['', row, row, reported, reported, reported + '\n' + second, reported + '\n' + second_reported],
            held=[self.HELD, self.TAKEN, 'q2|2|4101|0|0|'], after=[self.TAKEN, '', ''])
        self.assertIn('passed on attempt 3/3 after 2 retries', case.result)
        self.assertEqual(case.gui_open.call_count, 2)

    def test_a_late_copy_while_chirpstack_still_holds_the_item_fails(self):
        """Review r4 probe A, inverted: a late copy with the item still queued is no ground for a second re-send."""
        row = self.expectation_row('e1', self.QUEUE)
        case = self.valve_case(
            [[None], [139.31], [1.0]],
            error=f'a late copy of the open arrived, but ChirpStack still holds queue item {self.QUEUE}: '
                  'ChirpStack downlink 99',
            frames=[self.window(self.refused(1), 1), self.window(self.refused(2).replace(self.DOWNLINK, '99'), 2),
                    self.window(self.scheduled(3), 3), self.window('', 4)],
            edges=['', row, row, row], held=[self.HELD, self.TAKEN, self.TAKEN], after=[self.TAKEN, self.TAKEN, ''])
        self.assertEqual(self.sent(case), [b'trigger', b'trigger'])
        case.gui_open.assert_called_once()

    def test_a_too_old_drop_cannot_earn_a_resend(self):
        """An ID-less "too old" drop in the slot is no decision: the attempt fails instead of being re-sent."""
        row = self.expectation_row('e1', self.QUEUE)
        slot = self.slot(1)
        dropped = (self.command() + f'dl enqueue {self.DOWNLINK} {slot} {slot - 140454}\n'
                   f'dl too-old - {slot} {slot + 19900}\n' + self.ack('TOO_LATE', 'IGNORED'))
        case = self.valve_case(
            [[None], [1.0]], error='the attempt is not credited',
            frames=[self.window(dropped, 1), self.window(self.scheduled(2), 2), self.window('', 3)],
            edges=['', row, row, row], held=[self.HELD, self.TAKEN], after=[self.TAKEN, ''])
        self.assertEqual(self.sent(case), [b'trigger'])
        self.assertIn('no TX or refusal logged for it', str(case.error))

    def test_a_tx_outside_its_enqueued_slot_cannot_credit_a_delivery(self):
        """Enqueued for RX1, TX logged at RX2: the on-time delivery is not credited and the case fails."""
        row = self.expectation_row('e1', self.QUEUE)
        first, second = self.slot(1), self.slot(1, 2)
        across = (self.command() + f'dl enqueue {self.DOWNLINK} {first} {first - 140454}\n'
                  f'dl tx {self.DOWNLINK} {second} -\n' + self.ack('OK', 'IGNORED'))
        case = self.valve_case([[1.0]], error='the attempt is not credited',
                               frames=[self.window(across, 1), self.window('', 2)],
                               edges=['', row], held=[self.HELD], after=[''])
        self.assertEqual(self.sent(case), [b'trigger'])
        case.valve.downlink.assert_called_once()

    def test_an_accepted_expectation_without_its_effect_snapshot_sends_nothing(self):
        """The edge must record the command it queued; the harness never fills in FPort 2 and payload 4101 for it."""
        transport = {'phase': 'ACCEPTED', 'queue_id': self.QUEUE, 'accepted_at': '2025-04-13T16:49:14.498Z'}
        for snapshot in (None, {'fPort': 2}, {'bytes_hex': '4101'}):
            with self.subTest(snapshot=snapshot):
                row = 'e1|PENDING_OBSERVATION|||' + json.dumps(
                    {**transport, **({'effect_snapshot': snapshot} if snapshot else {})}).encode().hex()
                case = self.valve_case(
                    [[1.0]], error=f'the edge recorded no FPort and payload in the effect snapshot of queue item {self.QUEUE}, '
                                   'so the command it queued is unknown; no uplink was sent',
                    edges=['', row], held=[self.HELD], after=[''], frames=[self.window(self.scheduled(1), 1)])
                self.assertEqual(self.sent(case), [])

    def test_an_on_time_delivery_whose_item_chirpstack_still_holds_fails(self):
        """TX logged, no ack, item still queued: the on-time delivery does not pass, since the next uplink would repeat it."""
        row = self.expectation_row('e1', self.QUEUE)
        slot = self.slot(1)
        unacked = self.command() + f'dl enqueue {self.DOWNLINK} {slot} {slot - 140454}\ndl tx {self.DOWNLINK} {slot} -\n'
        case = self.valve_case(
            [[1.0]], error=f'the open was delivered on time, but ChirpStack still holds queue item {self.QUEUE}, which '
                           'the next uplink would deliver again',
            frames=[self.window(unacked, 1), self.window('', 2)], edges=['', row], held=[self.HELD], after=[self.TAKEN])
        self.assertEqual(self.sent(case), [b'trigger'])
        consumed = self.valve_case([[1.0]], frames=[self.window(self.scheduled(1), 1), self.window('', 2)],
                                   edges=['', row], held=[self.HELD], after=[''])
        self.assertEqual(consumed.result, 'WM1302 model delivered=2, Concentratord frames received=2')

    def test_another_item_left_queued_after_a_late_delivery_fails_before_the_close_out(self):
        """A second open behind a late one would be delivered by the close-out reports; the case fails first."""
        row = self.expectation_row('e1', self.QUEUE)
        case = self.valve_case(
            [[139.31], [1.0]], error='the open was delivered, but ChirpStack still holds item dup FPort 2 data 4101',
            frames=[self.window(self.scheduled(1), 1)], edges=['', row, row, row],
            held=[self.HELD + '\ndup|2|4101|0|0|'], after=['dup|2|4101|0|0|'])
        self.assertEqual(self.sent(case), [b'trigger'])
        case.gui_open.assert_called_once()

    def test_two_records_of_one_downlink_command_bind_neither(self):
        """Each forwarder command record counts; the same ID logged twice is two records, not one command."""
        row = self.expectation_row('e1', self.QUEUE)
        case = self.valve_case(
            [[1.0]], error=f'2 ChirpStack downlink commands in the window ({self.DOWNLINK}, {self.DOWNLINK}); none can be '
                           f'bound to queue item {self.QUEUE}; the attempt is not credited',
            frames=[self.window(self.command() + self.scheduled(1), 1)], edges=['', row], held=[self.HELD], after=[''])
        self.assertEqual(self.sent(case), [b'trigger'])

    def test_a_failed_radio_drain_leaves_the_attempts_receipt(self):
        """The drain before an attempt belongs to it: a failure there is logged and nothing is opened or sent."""
        row = self.expectation_row('e1', self.QUEUE)
        air, valve, vm, clock = self.valve_fixture([[1.0]], edges=['', row], held=[self.HELD])
        air.begin_case.side_effect = RuntimeError('partial packet on the radio socket')
        gui_open, output = Mock(), io.StringIO()
        with (patch.object(radio_suite.time, 'monotonic', clock), patch.object(radio_suite.time, 'sleep'),
              redirect_stdout(output), self.assertRaisesRegex(RuntimeError, 'partial packet')):
            radio_suite.run_valve(vm, air, {radio_suite.VALVE: valve}, gui_open)
        self.assertEqual(output.getvalue().strip(), f'{radio_suite.VALVE} valve open attempt 1/3 (open, queue item -): '
                                                    'failed: RuntimeError: partial packet on the radio socket')
        gui_open.assert_not_called()
        air.send.assert_not_called()

    def test_an_earlier_row_that_disappears_fails_the_case(self):
        """The earlier expectation must still exist when the successful attempt is reported."""
        closed = self.reported('e1', self.QUEUE)
        second, second_reported = self.expectation_row('e2', 'q2'), self.reported('e2', 'q2')
        case = self.reissue(edges=['', self.expectation_row('e1', self.QUEUE), closed, closed, closed + '\n' + second,
                                   second_reported],
                            error='the earlier open e1 changed while attempt 2 was reported: its row is gone')
        self.assertEqual(self.sent(case), [b'trigger', b'opened', b'closed', b'trigger', b'opened'])

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

    def run_valve_case(self, vm, failing=False):
        """Run only the valve case of stock_cases; return what the case returned, or re-raise the valve error."""
        outcome = []

        def test(label, fn):
            if label == 'Valve open and outcome':
                if failing:
                    with self.assertRaisesRegex(RuntimeError, 'fixture valve failure'):
                        fn()
                else:
                    outcome.append(fn())

        with (redirect_stdout(io.StringIO()), patch.object(acceptance, 'gui', return_value='')):
            acceptance.stock_cases(vm, None, test)
        return outcome

    def log_guest(self, receipts, ram_log='JoinRequest'):
        return SimpleNamespace(command=lambda script, *_args, **_keywords: self.run_log_script(script, receipts, ram_log),
                               radio=None, receipts=receipts, note=Mock())

    def test_valve_case_saves_the_radio_log_and_both_queues_pass_or_fail(self):
        """Radio daemon and marker lines from both log files, plus both queue states, are saved whatever the verdict."""
        line = 'Sun Apr 13 16:49:17 2025 '
        radio = [
            line + 'user.notice osi-radio-suite: marker-0001',
            line + 'user.info chirpstack-concentratord-sx1302[10712]: Frame received, uplink_id: 1902493660, count_us: 247517304',
            line + 'user.info chirpstack-mqtt-forwarder[10944]: Received downlink command, downlink_id: 3000953403',
            line + 'user.info chirpstack-concentratord-sx1302[10712]: Scheduled packet for TX, downlink_id: 3000953403, count_us: 248517304']
        for failing in (False, True):
            with self.subTest(failing=failing), tempfile.TemporaryDirectory() as directory:
                receipts = Path(directory)
                (receipts/'osi-system.log.old').write_text('\n'.join([
                    line + 'daemon.notice procd: /etc/rc.d/S99zzz-lorawan-devices.init: 2025-04-13T16:49:07.115143Z  INFO '
                    'chirpstack::storage::device_profile_template: Device-profile template upserted', radio[0], radio[1]]) + '\n')
                (receipts/'osi-system.log').write_text('\n'.join([
                    radio[2], line + 'daemon.info node[13309]: 13 Apr 16:49:17 - [warn] token=never-saved', radio[3]]) + '\n')
                item = radio_suite.QueueItem(self.QUEUE, '2', '4101', '0', '0', '')
                expectation = radio_suite.Expectation('a56e55db', 'PENDING_OBSERVATION', self.QUEUE, 'ACCEPTED',
                                                      '2025-04-13T16:49:14.498Z', open_at='2025-04-13 16:52:00+00:00')
                vm = self.log_guest(receipts)
                with (patch.object(radio_suite, 'run_valve', return_value='valve evidence',
                                   side_effect=RuntimeError('fixture valve failure') if failing else None),
                      patch.object(radio_suite, '_edge_expectations', return_value=radio_suite.EdgeState((expectation,))) as edge,
                      patch.object(radio_suite, '_chirpstack_queue',
                                   return_value=radio_suite.QueueState((item,))) as queue):
                    outcome = self.run_valve_case(vm, failing)
                self.assertEqual((receipts/'valve-radio.log').read_text(), '\n'.join(radio) + '\n')
                self.assertEqual((receipts/'valve-queue.log').read_text(), (
                    f'edge valve_actuation_expectations for {radio_suite.VALVE}:\n'
                    f'a56e55db PENDING_OBSERVATION queue item {self.QUEUE} ACCEPTED at 2025-04-13T16:49:14.498Z OPEN evidence\n'
                    f'ChirpStack device_queue_item for {radio_suite.VALVE}:\n'
                    f'{self.QUEUE} FPort 2 data 4101 is_pending 0 is_encrypted 0\n'))
                edge.assert_called_once_with(vm, radio_suite.VALVE)
                queue.assert_called_once_with(vm, radio_suite.VALVE)
                vm.note.assert_not_called()
                self.assertEqual(outcome, [] if failing else ['valve evidence'])

    def test_incomplete_capture_is_written_and_stays_visible_after_a_pass(self):
        """A queue read that fails leaves its marker and a note; after a pass the case row says so."""
        with tempfile.TemporaryDirectory() as directory:
            receipts = Path(directory)
            (receipts/'osi-system.log').write_text('')
            vm = self.log_guest(receipts)
            with (patch.object(radio_suite, 'run_valve', return_value='valve evidence'),
                  patch.object(radio_suite, '_edge_expectations', return_value=radio_suite.EdgeState()),
                  patch.object(radio_suite, '_chirpstack_queue',
                               return_value=radio_suite.QueueState(error='ChirpStack database unreadable'))):
                outcome = self.run_valve_case(vm)
            self.assertEqual(outcome, ['valve evidence; evidence capture incomplete: ChirpStack database unreadable'])
            self.assertEqual((receipts/'valve-queue.log').read_text(), (
                f'edge valve_actuation_expectations for {radio_suite.VALVE}:\nempty\n'
                f'ChirpStack device_queue_item for {radio_suite.VALVE}:\n[incomplete] ChirpStack database unreadable\n'))
            vm.note.assert_called_once_with('valve diagnostics incomplete: ChirpStack database unreadable')

    def test_radio_log_keeps_the_newest_lines_within_its_bound_and_says_so(self):
        """Older radio lines are left out to fit the console reply; the receipt keeps the newest and names the gap."""
        lines = [f'Sun Apr 13 16:49:17 2025 user.info chirpstack-concentratord-sx1302[1]: Frame received, uplink_id: {n}'
                 for n in range(10)]
        with tempfile.TemporaryDirectory() as directory:
            receipts = Path(directory)
            (receipts/'osi-system.log').write_text('\n'.join(lines) + '\n')
            vm = self.log_guest(receipts)
            with (patch.object(radio_suite, 'RADIO_LOG', radio_suite._radio_log(3 * (len(lines[0]) + 1))),
                  patch.object(radio_suite, '_edge_expectations', return_value=radio_suite.EdgeState()),
                  patch.object(radio_suite, '_chirpstack_queue', return_value=radio_suite.QueueState())):
                problems = radio_suite.valve_diagnostics(vm)
            self.assertEqual(problems, ['radio log truncated: the oldest 7 radio lines were left out to fit the console reply'])
            self.assertEqual((receipts/'valve-radio.log').read_text(), '\n'.join(lines[7:]) + '\n[incomplete] ' + problems[0] + '\n')
        self.assertLess(2 * radio_suite.RADIO_LOG_LIMIT + 200, 2000000)

    def test_radio_log_read_failure_is_marked_incomplete_and_keeps_what_was_read(self):
        """A persistent log that cannot be read in full marks the receipt incomplete; lines already read stay."""
        line = 'Sun Apr 13 16:49:17 2025 user.info chirpstack-concentratord-sx1302[1]: Frame received, uplink_id: 1'
        for broken in (False, True):
            with self.subTest(broken=broken), tempfile.TemporaryDirectory() as directory:
                receipts = Path(directory)
                (receipts/'osi-system.log').write_text(line + '\n')
                if broken:
                    (receipts/'osi-system.log.old').mkdir()
                vm = self.log_guest(receipts)
                with (patch.object(radio_suite, '_edge_expectations', return_value=radio_suite.EdgeState()),
                      patch.object(radio_suite, '_chirpstack_queue', return_value=radio_suite.QueueState())):
                    problems = radio_suite.valve_diagnostics(vm)
                self.assertEqual(problems, ['a persistent log could not be read in full'] if broken else [])
                self.assertEqual((receipts/'valve-radio.log').read_text(), line + '\n' + (
                    '[incomplete] a persistent log could not be read in full\n' if broken else ''))

    def test_capture_saves_the_radio_log_before_it_reads_the_queues(self):
        """A guest that dies after the radio log keeps that log on disk; each queue read leaves its marker."""
        line = 'Sun Apr 13 16:49:17 2025 user.info chirpstack-concentratord-sx1302[10712]: Scheduled packet for TX, downlink_id: 3000953403\n'
        unreadable = "database unreadable: RuntimeError('guest serial closed')"
        with tempfile.TemporaryDirectory() as directory:
            receipts = Path(directory)
            vm = SimpleNamespace(command=Mock(side_effect=[(0, line), RuntimeError('guest serial closed'), RuntimeError('guest serial closed')]),
                                 radio=None, receipts=receipts, note=Mock())
            with patch.object(radio_suite, 'run_valve', return_value='valve evidence'):
                outcome = self.run_valve_case(vm)
            self.assertEqual((receipts/'valve-radio.log').read_text(), line)
            self.assertEqual((receipts/'valve-queue.log').read_text(), (
                f'edge valve_actuation_expectations for {radio_suite.VALVE}:\n[incomplete] edge {unreadable}\n'
                f'ChirpStack device_queue_item for {radio_suite.VALVE}:\n[incomplete] ChirpStack {unreadable}\n'))
            self.assertEqual(vm.command.call_count, 3)
            self.assertEqual(outcome, [f'valve evidence; evidence capture incomplete: edge {unreadable}, ChirpStack {unreadable}'])
            self.assertEqual(vm.note.call_args.args[0], f'valve diagnostics incomplete: edge {unreadable}, ChirpStack {unreadable}')

    def test_failed_evidence_capture_keeps_the_valve_verdict(self):
        """A capture that cannot write is noted and named in a passing case row; it neither masks the valve error nor fails a pass."""
        for failing in (False, True):
            with self.subTest(failing=failing), tempfile.TemporaryDirectory() as directory:
                receipts = Path(directory)
                vm = SimpleNamespace(command=Mock(), radio=None, receipts=receipts, note=Mock())
                with (patch.object(radio_suite, 'run_valve', return_value='valve evidence',
                                   side_effect=RuntimeError('fixture valve failure') if failing else None),
                      patch.object(radio_suite, 'valve_diagnostics', side_effect=OSError('disk full'))):
                    outcome = self.run_valve_case(vm, failing)
                vm.note.assert_called_once_with("valve diagnostics failed: OSError('disk full')")
                self.assertEqual(outcome, [] if failing else [
                    "valve evidence; evidence capture incomplete: capture failed: OSError('disk full')"])
                self.assertEqual(list(receipts.iterdir()), [])

    def test_valve_case_reads_the_gui_outcome_after_the_report(self):
        """The case ends with the GUI outcome check, and a failing one fails the case."""
        outcome = []

        def test(label, fn):
            if label == 'Valve open and outcome':
                outcome.append(fn())

        def refuses(label, fn):
            if label == 'Valve open and outcome':
                with self.assertRaisesRegex(RuntimeError, 'GUI outcome check failed'):
                    fn()

        with tempfile.TemporaryDirectory() as directory:
            vm = self.log_guest(Path(directory))
            with (patch.object(radio_suite, 'run_valve', return_value='valve evidence'),
                  patch.object(radio_suite, 'valve_diagnostics', return_value=[]),
                  patch.object(acceptance, 'gui', return_value='') as gui):
                acceptance.stock_cases(vm, None, test)
                gui.assert_called_once_with(vm, None, 'outcome', radio_suite.VALVE)
            self.assertEqual(outcome, ['valve evidence'])
            with (patch.object(radio_suite, 'run_valve', return_value='valve evidence'),
                  patch.object(radio_suite, 'valve_diagnostics', return_value=[]),
                  patch.object(acceptance, 'gui', side_effect=RuntimeError('GUI outcome check failed'))):
                acceptance.stock_cases(vm, None, refuses)

    def test_valve_attempt_lines_reach_the_results_log(self):
        """stock_cases hands run_valve the same record function the join attempts use."""
        record = Mock()

        def test(label, fn):
            if label == 'Valve open and outcome':
                outcome.append(fn())

        outcome = []

        def run_valve(_vm, _air, _session, _gui_open, *, log):
            log('valve attempt line')
            return 'valve evidence'

        with (patch.object(radio_suite, 'run_valve', run_valve),
              patch.object(radio_suite, 'valve_diagnostics', return_value=[]),
              patch.object(acceptance, 'gui', return_value='')):
            acceptance.stock_cases(SimpleNamespace(radio=None), None, test, log=record)
        record.assert_called_once_with('valve attempt line')
        self.assertEqual(outcome, ['valve evidence'])

    def test_the_radio_log_leaves_node_red_and_the_ram_ring_alone(self):
        """The radio log is filtered on the guest: RAM-ring, import and Node-RED lines never leave it."""
        with tempfile.TemporaryDirectory() as directory:
            receipts = Path(directory)
            (receipts/'osi-system.log').write_text(
                'Sun Apr 13 16:49:17 2025 daemon.info node[13309]: 13 Apr 16:49:17 - [warn] token=never-saved\n'
                'Sun Apr 13 16:49:17 2025 daemon.notice procd: /etc/rc.d/S99zzz-lorawan-devices.init: INFO chirpstack::storage::x\n')
            with (patch.object(radio_suite, '_edge_expectations', return_value=radio_suite.EdgeState()),
                  patch.object(radio_suite, '_chirpstack_queue', return_value=radio_suite.QueueState())):
                problems = radio_suite.valve_diagnostics(self.log_guest(receipts, 'JoinRequest token=never-saved'))
            self.assertEqual(problems, [])
            self.assertEqual((receipts/'valve-radio.log').read_text(), '\n')
            self.assertNotIn('never-saved', (receipts/'valve-queue.log').read_text())

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

    def test_window_reads_the_forwarders_downlink_command_and_ack(self):
        """ChirpStack's downlink command and the gateway's ack for it, as the MQTT forwarder logs them."""
        forwarder = 'chirpstack-mqtt-forwarder[63]: '
        lines = [self.marker_line('fixture'), self.frame_line(81),
                 f'{self.LINE}info {forwarder}Received downlink command, downlink_id: 3000953403, '
                 'topic: us915_0/gateway/0016C001F1000001/command/down',
                 f'{self.LINE}info {forwarder}Sending downlink frame, downlink_id: 3000953403',
                 f'{self.LINE}info {self.DAEMON}Enqueueing timestamped packet, downlink_id: 3000953403, '
                 'counter_us: 138293609, current_counter_us: 138153155',
                 f'{self.LINE}info {self.DAEMON}Scheduled packet for TX, downlink_id: 3000953403, count_us: 138293609, '
                 'freq: 923300000, bw: 500000, mod: LoRa, dr: SF7',
                 f'{self.LINE}info {forwarder}Received ack, items: ["OK", "IGNORED"], downlink_id: 3000953403',
                 f'{self.LINE}info {forwarder}Sending ack event, downlink_id: 3000953403, '
                 'topic: us915_0/gateway/0016C001F1000001/event/ack',
                 f'{self.LINE}info {forwarder}Received downlink command, downlink_id: 7, '
                 'topic: us915_0/gateway/0016C001F1000001/command/down',
                 f'{self.LINE}info {forwarder}Received ack, items: ["TOO_LATE", "TOO_LATE"], downlink_id: 7']
        with tempfile.TemporaryDirectory() as directory:
            root = self.log_root(directory, lines)
            frames = radio_suite._concentratord_frames(self.guest_logs(root), self.snapshot(root/'osi-system.log', 0))
        self.assertEqual((frames.error, frames.matched), ('', [('81', 137293609)]))
        self.assertEqual(frames.commands, ['3000953403', '7'])
        self.assertEqual(frames.acks, [('["OK", "IGNORED"]', '3000953403'), ('["TOO_LATE", "TOO_LATE"]', '7')])
        self.assertEqual(frames.downlinks, [radio_suite.Downlink('enqueue', '3000953403', 138293609, 138153155),
                                            radio_suite.Downlink('tx', '3000953403', 138293609, None)])


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

    @unittest.skipUnless(shutil.which('sqlite3'), 'sqlite3 CLI absent')
    def test_edge_and_chirpstack_queries_read_the_queue_item(self):
        """Both queue reads against tables shaped like the edge's and ChirpStack 4.12.1's."""
        with tempfile.TemporaryDirectory() as directory:
            root = Path(directory)
            farming, chirpstack = root/'farming.db', root/'chirpstack.sqlite'
            snapshot = {'fPort': 2, 'bytes_hex': '4101', 'encoded_duration_seconds': 60}
            accepted = {'phase': 'ACCEPTED', 'queue_id': self.QUEUE, 'accepted_at': '2025-04-13T16:49:14.498Z',
                        'effect_snapshot': snapshot}
            reported = {'phase': 'ACCEPTED', 'queue_id': 'older', 'effect_snapshot': snapshot,
                        'untrusted_report': {'open': {'received_at': 'a'}, 'closed': {'received_at': 'b'}}}
            with closing(sqlite3.connect(farming)) as db:
                db.executescript(f"""
CREATE TABLE valve_actuation_expectations (expectation_id text primary key, device_eui text not null,
    reconciliation_state text not null default 'PENDING_OBSERVATION', transport_json text,
    observed_open_at text, observed_close_at text, commanded_duration_seconds integer not null default 60);
INSERT INTO valve_actuation_expectations(expectation_id, device_eui, reconciliation_state, transport_json,
    observed_open_at, observed_close_at) VALUES ('e1', 'a840410000000001', 'PENDING_OBSERVATION',
    '{json.dumps(accepted)}', NULL, NULL);
INSERT INTO valve_actuation_expectations(expectation_id, device_eui, reconciliation_state, transport_json,
    observed_open_at, observed_close_at) VALUES ('e2', 'A840410000000001', 'OBSERVED_RUNNING', NULL,
    '2025-04-13 16:52:00+00:00', NULL);
INSERT INTO valve_actuation_expectations(expectation_id, device_eui, reconciliation_state, transport_json,
    observed_open_at, observed_close_at) VALUES ('e3', 'A840410000000001', 'PENDING_OBSERVATION', 'not json', NULL, NULL);
INSERT INTO valve_actuation_expectations(expectation_id, device_eui, reconciliation_state, transport_json,
    observed_open_at, observed_close_at) VALUES ('e4', 'A840410000000001', 'PENDING_OBSERVATION', '{json.dumps(reported)}',
    NULL, NULL);
INSERT INTO valve_actuation_expectations(expectation_id, device_eui, reconciliation_state, transport_json,
    observed_open_at, observed_close_at) VALUES ('e5', 'A840410000000002', 'PENDING_OBSERVATION', '{json.dumps(accepted)}',
    NULL, NULL);
""")
            with closing(sqlite3.connect(chirpstack)) as db:
                db.executescript(f"""
CREATE TABLE device_queue_item (id text not null primary key,
    dev_eui blob references device on delete cascade not null, created_at datetime not null,
    f_port smallint not null, confirmed boolean not null, data blob not null, is_pending boolean not null,
    f_cnt_down bigint null, timeout_after datetime, is_encrypted boolean default FALSE not null, expires_at datetime null);
INSERT INTO device_queue_item VALUES ('{self.QUEUE}', x'A840410000000001', '2025-04-13 16:49:14.4+00:00',
    2, false, x'4101', false, NULL, NULL, false, '2025-04-13 17:20:13.71+00:00');
INSERT INTO device_queue_item VALUES ('q2', x'A840410000000002', '2025-04-13 16:49:15.4+00:00',
    2, false, x'4101', true, 1, NULL, true, '2025-04-13 17:20:13.71+00:00');
""")

            def command(script, timeout=None):
                script = script.replace(radio_suite.DB, quote(str(farming)))
                script = script.replace(radio_suite.CHIRPSTACK_DB, quote(str(chirpstack)))
                result = subprocess.run(['sh', '-c', script], capture_output=True, text=True)
                return result.returncode, result.stdout.strip()

            vm = SimpleNamespace(command=command)
            expectation, item = radio_suite.Expectation, radio_suite.QueueItem
            state = radio_suite._edge_expectations(vm, 'A840410000000001')
            self.assertEqual(state, radio_suite.EdgeState((
                expectation('e1', 'PENDING_OBSERVATION', self.QUEUE, 'ACCEPTED', '2025-04-13T16:49:14.498Z', '2', '4101', 60),
                expectation('e2', 'OBSERVED_RUNNING', open_at='2025-04-13 16:52:00+00:00'),
                expectation('e3', 'PENDING_OBSERVATION'),
                expectation('e4', 'PENDING_OBSERVATION', 'older', 'ACCEPTED', None, '2', '4101', 60, '', '',
                            json.dumps(reported['untrusted_report'], sort_keys=True)))))
            self.assertEqual(radio_suite._chirpstack_queue(vm, 'A840410000000001'),
                             radio_suite.QueueState((item(self.QUEUE, '2', '4101', '0', '0', ''),)))
            self.assertEqual(radio_suite._chirpstack_queue(vm, 'A840410000000002'),
                             radio_suite.QueueState((item('q2', '2', '4101', '1', '1', '1'),)))
            held = radio_suite.QueueState((item(self.QUEUE, '2', '4101', '0', '0', ''),
                                          item('other', '3', '4101', '0', '0', '')))
            self.assertEqual(radio_suite._valve_queued(held, self.QUEUE, ('2', '4101'))[1:], (None, ''))
            self.assertIn('as FPort 3 payload 4101', radio_suite._valve_queued(held, 'other', ('2', '4101'))[1])
            self.assertIn('does not hold queue item', radio_suite._valve_queued(held, 'missing', ('2', '4101'))[1])

            def evidence(identifier, kind, seconds=None):
                return sql_cli(radio_suite._expectation_evidence(identifier, kind, seconds))

            def sql_cli(query):
                script = f"sqlite3 -readonly -batch -bail -cmd '.timeout 5000' {quote(str(farming))} <<\'SQL\'\n{query}\nSQL"
                result = subprocess.run(['sh', '-c', script], capture_output=True, text=True)
                self.assertEqual(result.returncode, 0, result.stderr)
                return result.stdout.strip()

            self.assertEqual(evidence('e4', 'open', 60), 'yes')
            self.assertEqual(evidence('e4', 'closed'), 'yes')
            self.assertEqual(evidence('e1', 'open'), '')
            self.assertEqual(evidence('e2', 'open'), 'yes')
            self.assertEqual(evidence('e4', 'open', 61), '')
            farming.unlink()
            chirpstack.unlink()
            self.assertEqual(radio_suite._edge_expectations(vm, 'A840410000000001'),
                             radio_suite.EdgeState(error='edge database unreadable'))
            self.assertEqual(radio_suite._chirpstack_queue(vm, 'A840410000000001'),
                             radio_suite.QueueState(error='ChirpStack database unreadable'))
            with self.assertRaisesRegex(ValueError, 'invalid device identifier'):
                radio_suite._edge_expectations(vm, "x' OR 1=1 --")
            with self.assertRaisesRegex(ValueError, 'invalid device identifier'):
                radio_suite._chirpstack_queue(vm, "x' OR 1=1 --")
            with self.assertRaisesRegex(ValueError, 'invalid expectation identifier'):
                radio_suite._expectation_evidence("x' OR 1=1 --", 'open')




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

        upgrade_suite.wait_for_api(SimpleNamespace(command=command, API_WAIT_SECONDS=420, private=True))

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
        log = log.replace(self.line(21, self.DAEMON), self.line(36, self.DAEMON))
        self.assertIn('cut short after 15 s', tailscale_boot.normal_verdict(log, 15))

    def test_a_daemon_that_starts_before_its_cleanup_ended_fails_the_normal_verdict(self):
        cleanup, _flush, daemon = self.normal_log().splitlines()[1:4]
        gave_up = self.line(35, 'user.notice tailscale: cleanup did not finish in 15 s; continuing without it')
        nr = self.normal_log().splitlines()[0]
        for label, lines in [
            ['daemon before the give-up', [nr, cleanup, daemon, gave_up]],
            ['daemon before the flush', [nr, cleanup, daemon, self.line(22, self.RC + 'S99tailscale: flushing log.')]],
        ]:
            with self.subTest(label):
                with self.assertRaisesRegex(RuntimeError, 'did not start after its cleanup had ended'):
                    tailscale_boot.normal_verdict('\n'.join(lines), 15)

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
        for name in (*over_ssh, 'PROCESS_STARTS', 'SURVIVOR_WRAPPER', 'LOCK_HOLDERS', 'BOOTSTRAP_TIMER', 'RESTART'):
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

    def test_the_restart_probe_parses_and_its_verdict_needs_a_survivor_off_the_lock(self):
        restart = tailscale_boot.RESTART.replace('RESTART_LIMIT', '90')
        for shell in ('sh', 'bash'):
            self.assertEqual(subprocess.run([shell, '-n', '-c', restart]).returncode, 0)
        receipt = tailscale_boot.lock_verdict('done 33', 'survivors=2 holders=0 lock=present', 'done 32')
        with self.assertRaisesRegex(RuntimeError, 'exited with an error'):
            tailscale_boot.lock_verdict('done 33', 'survivors=2 holders=0 lock=present', 'failed 32 rc=1')
        status = subprocess.run(['bash', '-c', restart.replace('/etc/init.d/tailscale restart', 'sh -c "exit 3"')],
                                capture_output=True, text=True, timeout=30)
        self.assertRegex(status.stdout.strip(), r'^failed \d+ rc=3$')
        ok = subprocess.run(['bash', '-c', restart.replace('/etc/init.d/tailscale restart', 'true')],
                            capture_output=True, text=True, timeout=30)
        self.assertRegex(ok.stdout.strip(), r'^done \d+$')
        self.assertIn('2 surviving cleanup', receipt)
        self.assertIn('none holding the procd lock', receipt)
        for label, first, holders, second, reason in [
            ['blocked', 'done 33', 'survivors=2 holders=2 lock=present', 'blocked 90', 'hold the procd lock'],
            ['second blocked only', 'done 33', 'survivors=2 holders=0 lock=present', 'blocked 90', 'waited on the lock'],
            ['no survivor', 'done 33', 'survivors=0 holders=0 lock=present', 'done 32', 'no cleanup outlived'],
            ['no lock taken', 'done 33', 'survivors=2 holders=0 lock=', 'done 32', 'did not take the service lock'],
            ['first blocked', 'blocked 90', 'survivors=2 holders=0 lock=present', 'done 1', 'first restart did not finish'],
        ]:
            with self.subTest(label):
                with self.assertRaisesRegex(RuntimeError, reason):
                    tailscale_boot.lock_verdict(first, holders, second)

    def test_the_bootstrap_timer_is_read_per_boot_and_judged_over_all_of_them(self):
        log = '\n'.join([
            'Sun Apr 13 16:51:24 2025 user.notice osi-test-bootstrap: start uptime=46.12 stamp=yes',
            'Sun Apr 13 16:51:24 2025 user.notice osi-test-bootstrap: end uptime=46.31 rc=0',
        ])
        self.assertEqual(tailscale_boot.bootstrap_runs(log), [(0.19, 'yes', 0)])
        good = [(f'boot {n}', [(0.2 + n / 10, 'yes', 0)]) for n in range(4)]
        receipt = tailscale_boot.bootstrap_verdict(good)
        self.assertIn('4 stamped boots', receipt)
        self.assertIn('worst 0.50 s (boot 3)', receipt)
        for label, measured, reason in [
            ['unstamped', good[:3] + [('boot 3', [(0.3, 'no', 0)])], 'stamp=no'],
            ['slow', good[:3] + [('boot 3', [(7.5, 'yes', 0)])], 'took 7.5 s'],
            ['not timed', good[:3] + [('boot 3', [])], 'exactly one'],
            ['too few', good[:3], 'only 3 boots'],
            ['failed', good[:3] + [('boot 3', [(0.3, 'yes', 1)])], 'exited 1'],
        ]:
            with self.subTest(label):
                with self.assertRaisesRegex(RuntimeError, reason):
                    tailscale_boot.bootstrap_verdict(measured)

    def test_the_marker_waits_until_the_persistent_log_has_it(self):
        with tempfile.TemporaryDirectory() as directory:
            log = Path(directory)/'osi-system.log'
            log.write_text('older line\n')
            script = tailscale_boot.mark_script('OSI-TAILSCALE-cccc', (str(log),))
            bin_dir = Path(directory)/'bin'
            bin_dir.mkdir()
            # A logger whose line lands in the file a second later, as logread -F does.
            # Its output is closed, so the captured pipes end with the shell
            # under test and the time measured is that shell's wait.
            (bin_dir/'logger').write_text(f'#!/bin/sh\n(sleep 1; echo "x osi-test: $3" >>{quote(str(log))}) </dev/null >/dev/null 2>&1 &\n')
            (bin_dir/'logger').chmod(0o755)
            # The image's BusyBox sleep takes whole seconds only.
            real_sleep = shutil.which('sleep')
            (bin_dir/'sleep').write_text('#!/bin/sh\ncase "$1" in *[!0-9]*) echo "sleep: invalid number \'$1\'" >&2; exit 1 ;; esac\n'
                                       f'exec {real_sleep} "$1"\n')
            (bin_dir/'sleep').chmod(0o755)
            env = dict(os.environ, PATH=f'{bin_dir}:{os.environ["PATH"]}')
            began = time.monotonic()
            run = subprocess.run(['sh', '-c', script], env=env, capture_output=True, text=True, timeout=60)
            self.assertEqual(run.returncode, 0, run.stderr)
            self.assertGreaterEqual(time.monotonic() - began, 0.9, 'it waited for the writer')
            self.assertIn('OSI-TAILSCALE-cccc', log.read_text())
            (bin_dir/'logger').write_text('#!/bin/sh\nexit 0\n')
            self.assertNotIn('sleep: invalid number', run.stderr)
            began = time.monotonic()
            lost = subprocess.run(['sh', '-c', tailscale_boot.mark_script('OSI-TAILSCALE-dddd', (str(log),)).replace('-le 20', '-le 2')],
                                  env=env, capture_output=True, text=True, timeout=60)
            self.assertEqual(lost.returncode, 3)
            self.assertGreaterEqual(time.monotonic() - began, 1.9, 'a lost marker is waited for, not polled in a busy loop')
            self.assertIn('-le 20 ] || exit 3; sleep 1', tailscale_boot.mark_script('x'))

    def test_osi_bootstrap_must_end_before_s99tailscale_on_a_patched_boot(self):
        start = 'Sun Apr 13 16:52:22 2025 user.notice osi-test-bootstrap: start uptime=47.15 stamp=yes'
        end = 'Sun Apr 13 16:52:22 2025 user.notice osi-test-bootstrap: end uptime=47.24 rc=0'
        ts = self.line(23, self.RC + 'S99tailscale: Program starting: v1.80.3-1 (OpenWrt), Go 1.23.8: []string{"/usr/sbin/tailscaled", "--cleanup"}')
        self.assertTrue(tailscale_boot.bootstrap_before_tailscale('\n'.join([start, end, ts])))
        self.assertFalse(tailscale_boot.bootstrap_before_tailscale('\n'.join([start, ts, end])))
        self.assertFalse(tailscale_boot.bootstrap_before_tailscale('\n'.join([start, end])))
        good = [(f'boot {n}', [(0.1, 'yes', 0)], True if n < 2 else None) for n in range(4)]
        self.assertIn('4 stamped boots', tailscale_boot.bootstrap_verdict(good))
        with self.assertRaisesRegex(RuntimeError, 'S99tailscale ran before osi-bootstrap'):
            tailscale_boot.bootstrap_verdict([good[0], ('boot 1', [(0.1, 'yes', 0)], False), *good[2:]])

    def test_the_media_build_refuses_a_launcher_without_its_companions(self):
        with tempfile.TemporaryDirectory() as directory:
            release = Path(directory)
            (release/'scripts').mkdir()
            launcher = release/'scripts/deploy-offline.sh'
            launcher.write_text('#!/bin/sh\nexec node "$script_dir/deploy-offline-runtime.js" "$@"\n')
            (release/'scripts/deploy-offline-runtime.js').write_text('')
            self.assertEqual(upgrade_suite.missing_companions(release), ['deploy-archive.js', 'deploy-local-server.js'])
            with self.assertRaisesRegex(ValueError, 'needs files the release lacks: deploy-archive.js'):
                upgrade_suite.build_media(release, release, revision='a' * 40)
            for name in upgrade_suite.OFFLINE_COMPANIONS:
                (release/'scripts'/name).write_text('')
            self.assertEqual(upgrade_suite.missing_companions(release), [])
            launcher.write_text('#!/bin/sh\n# a self-contained launcher\n')
            for name in upgrade_suite.OFFLINE_COMPANIONS:
                (release/'scripts'/name).unlink()
            self.assertEqual(upgrade_suite.missing_companions(release), [], 'an older launcher needs none')

    def test_chirpstack_and_node_red_must_start_before_the_stall(self):
        log = self.stall_log().replace('cleanup stall started', 'cleanup stall started uptime=47.40')
        receipt = tailscale_boot.start_order_verdict(log, 'chirpstack 2210\nnode-red 4605\n')
        self.assertIn('ChirpStack started at 22.10 s and Node-RED at 46.05 s', receipt)
        for label, processes, reason in [
            ['Node-RED after the stall', 'chirpstack 2210\nnode-red 6100\n', 'node-red started at 61.00 s, after the stall'],
            ['ChirpStack after the stall', 'chirpstack 4800\nnode-red 4605\n', 'chirpstack started at 48.00 s'],
            ['Node-RED missing', 'chirpstack 2210\n', 'node-red is not running'],
        ]:
            with self.subTest(label):
                with self.assertRaisesRegex(RuntimeError, reason):
                    tailscale_boot.start_order_verdict(log, processes)
        with self.assertRaisesRegex(RuntimeError, 'did not log its uptime'):
            tailscale_boot.start_order_verdict(self.stall_log(), 'chirpstack 2210\nnode-red 4605\n')
        self.assertIn("uptime=$(cut -d' ' -f1 /proc/uptime)", tailscale_boot.STALL_WRAPPER)

    def test_a_real_cleanup_cut_off_must_come_at_the_limit(self):
        nr, cleanup = self.normal_log().splitlines()[:2]  # the cleanup starts at 16:50:20

        def at(second, text):
            return f'Sun Apr 13 16:{50 + second // 60:02d}:{second % 60:02d} 2025 ' + text

        for after, ok in [(15, True), (23, True), (60, False), (10, False)]:
            gave_up = at(20 + after, 'user.notice tailscale: cleanup did not finish in 15 s; continuing without it')
            log = '\n'.join([nr, cleanup, gave_up, at(21 + after, self.DAEMON)])
            with self.subTest(after=after):
                if ok:
                    self.assertIn('cut short after 15 s', tailscale_boot.normal_verdict(log, 15))
                else:
                    with self.assertRaisesRegex(RuntimeError, f'gave up {after} s after the real cleanup began'):
                        tailscale_boot.normal_verdict(log, 15)

    def test_the_upgraded_guest_gets_the_media_path_not_its_builder(self):
        media = Path('/nonexistent/upgrade.img')
        seen = {}

        class Stop(Exception):
            pass

        def make_guest(work, image, qemu, ram, **options):
            seen.setdefault(Path(work).name, options)
            raise Stop

        outcome = {}

        def test(label, fn):
            try:
                outcome[label] = fn()
            except Exception as error:  # the runner's test() records, never raises
                outcome[label] = error

        args = type('Args', (), {'qemu': Path('qemu'), 'ram': 4})()
        with tempfile.TemporaryDirectory() as directory:
            release = Path(directory)
            (release/tailscale_boot.INIT).parent.mkdir(parents=True)
            (release/tailscale_boot.INIT).write_text('OSI_CLEANUP_LIMIT=15\n')
            tailscale_boot.run(args, release, release, release, make_guest, test, print,
                               lambda old: release/'fixture.img.gz', lambda: media, None)
        self.assertEqual(seen['tailscale-upgraded']['upgrade'], media)
        self.assertIsInstance(outcome[tailscale_boot.INSTALLED_CASE], Stop)

    def test_a_release_the_media_cannot_be_built_from_still_runs_the_fallback(self):
        built = []

        def make_guest(work, image, qemu, ram, **options):
            built.append(Path(work).name)
            raise RuntimeError('stop here')

        outcome = {}

        def test(label, fn):
            try:
                outcome[label] = fn()
            except Exception as error:
                outcome[label] = error

        def media():
            raise ValueError('deploy-offline.sh needs files the release lacks: deploy-archive.js')

        args = type('Args', (), {'qemu': Path('qemu'), 'ram': 4})()
        with tempfile.TemporaryDirectory() as directory:
            release = Path(directory)
            (release/tailscale_boot.INIT).parent.mkdir(parents=True)
            (release/tailscale_boot.INIT).write_text('OSI_CLEANUP_LIMIT=15\n')
            tailscale_boot.run(args, release, release, release, make_guest, test, print,
                               lambda old: release/'fixture.img.gz', media, None)
        self.assertIn('needs files the release lacks', str(outcome[tailscale_boot.INSTALLED_CASE]))
        self.assertIn('not run', str(outcome[tailscale_boot.STALL_CASE]))
        self.assertEqual(built, ['tailscale-fallback'], 'the fallback guest was still built')
        self.assertIn(tailscale_boot.FALLBACK_CASE, outcome)

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
                command.return_value = (0, '27')
                vm.shell()
            vm.stop()
            self.assertEqual(expect.call_args_list, [call(b':~#', 40)])
            # The same probe that proves the shell answers says where the
            # guest's persistent syslog stood when this boot's console came up.
            command.assert_called_once_with(Guest.LOG_COUNT)
            self.assertEqual(vm.log_from, 27)
            self.assertEqual(BootWaitTests.noted(vm), ['shell prompt ready after T s (budget 40 s)'])

    def test_the_image_receipt_never_fails_and_names_the_boot_links(self):
        vm = Mock()
        vm.command.return_value = (0, 'S80tailscale\ndigest=a874f9fd10321e57b00660af11695618e23fb622bb1a40bcd0d366dad1340e56')
        self.assertEqual(tailscale_boot.image_receipt(vm), 'S80tailscale, init digest a874f9fd1032')
        # Guest.command() strips its output, so an empty digest arrives as `digest=`.
        vm.command.return_value = (0, 'S99tailscale\ndigest=')
        self.assertEqual(tailscale_boot.image_receipt(vm), 'S99tailscale, init digest absent')
        vm.command.return_value = (0, 'digest=')
        self.assertEqual(tailscale_boot.image_receipt(vm), 'no boot link, init digest absent')
        vm.command.return_value = (0, 'S80tailscale\ndigest')
        self.assertEqual(tailscale_boot.image_receipt(vm), 'S80tailscale, init digest absent')
        # A failed read whose shell answers again is diagnostics only.
        vm.command.side_effect = [TimeoutError('guest serial timed out'), (0, '')]
        self.assertIn('unreadable', tailscale_boot.image_receipt(vm))
        vm.send.assert_called_with(b'\x03\n')
        self.assertEqual(vm.command.call_args_list[-1], call('true', 30))
        # A shell that stays busy is not handed to the next query.
        vm.command.side_effect = [TimeoutError('guest serial timed out'), TimeoutError('guest serial timed out')]
        with self.assertRaisesRegex(RuntimeError, 'did not answer after the image receipt'):
            tailscale_boot.image_receipt(vm)


class BootWaitTests(unittest.TestCase):
    """Every boot wait notes its elapsed time against its budget; a slow API wait keeps the boot's timing."""

    def guest(self, directory, cls=Guest, *, private=False):
        # A Guest without an image: only what a wait and its notes need.
        vm = cls.__new__(cls)
        vm.receipts = Path(directory)
        vm.process = vm.bridge = vm.radio = None
        vm.boots = 3
        vm.private = private
        vm.command, vm.send = Mock(), Mock()
        vm.start, vm.stop, vm.reboot, vm.verify_cut_disk = Mock(), Mock(), Mock(), Mock()
        return vm

    @staticmethod
    def polls_until(answer_at):
        """A guest command stand-in that runs a poll script on the host; the first 401 comes at poll `answer_at`."""
        def command(script, timeout):
            # With fast curls and two seconds between polls, each poll stands for two seconds.
            fixture = (f'polls=0\ncurl() {{ [ "$polls" -ge {answer_at - 1} ] && printf 401; }}\n'
                       'sleep() { [ "$1" = 2 ] || exit 2; polls=$((polls + 1)); }\n')
            result = subprocess.run(['sh', '-c', fixture + script], capture_output=True, text=True)
            return result.returncode, result.stdout.strip()
        return command

    @staticmethod
    def noted(vm):
        """The guest's boot-wait notes, each elapsed time masked: a loaded host can round 0.0 s up."""
        return [re.sub(r'\d+\.\d s', 'T s', note) for note in vm.waits]

    def test_pi5_api_wait_polls_420_s_and_notes_its_elapsed_time(self):
        self.assertEqual(Guest.API_WAIT_SECONDS, 420)
        with tempfile.TemporaryDirectory() as directory:
            vm = self.guest(directory)
            # The measured 246 s factory first boot is the 124th poll.
            vm.command.side_effect = self.polls_until(124)
            self.assertRegex(upgrade_suite.wait_for_api(vm), r'^\w{3} \w{3} +\d+ \d\d:\d\d:\d\d \d{4}$')
            script, timeout = vm.command.call_args.args
            self.assertEqual(timeout, 420)
            self.assertIn('seq 1 210', script)
            self.assertRegex(vm.waits[0], r'^api ready after \d+\.\d s \(budget 420 s\)$')
            self.assertEqual((vm.receipts/'harness-events.log').read_text(), f'boot=3 {vm.waits[0]}\n')

    def test_a_board_class_sets_its_own_api_wait_budget(self):
        class SlowBoard(Guest):
            API_WAIT_SECONDS = 900
        with tempfile.TemporaryDirectory() as directory:
            vm = self.guest(directory, SlowBoard)
            # Past every poll the Pi 5 budget has, and the last one this budget has.
            vm.command.side_effect = self.polls_until(450)
            upgrade_suite.wait_for_api(vm)
            script, timeout = vm.command.call_args.args
            self.assertEqual(timeout, 900)
            self.assertIn('seq 1 450', script)
            self.assertRegex(vm.waits[0], r'^api ready after \d+\.\d s \(budget 900 s\)$')

    def test_an_api_wait_past_the_budget_fails_and_is_noted_as_not_ready(self):
        with tempfile.TemporaryDirectory() as directory:
            vm = self.guest(directory)
            # The loop runs out by itself, then the host budget runs out first.
            vm.command.side_effect = self.polls_until(300)
            with self.assertRaisesRegex(RuntimeError, 'guest command returned 1'):
                upgrade_suite.wait_for_api(vm)
            vm.command.side_effect = TimeoutError('guest serial timed out')
            with self.assertRaisesRegex(TimeoutError, 'guest serial timed out'):
                upgrade_suite.wait_for_api(vm)
            self.assertEqual(self.noted(vm), ['api not ready after T s (budget 420 s)'] * 2)

    def test_a_private_guest_keeps_no_wait_note(self):
        with tempfile.TemporaryDirectory() as directory:
            vm = self.guest(directory, private=True)
            vm.command.side_effect = self.polls_until(1)
            upgrade_suite.wait_for_api(vm)
            vm.command.side_effect = TimeoutError('guest serial timed out')
            with self.assertRaises(TimeoutError):
                upgrade_suite.wait_for_api(vm)
            self.assertEqual(vm.waits, ())
            self.assertEqual(list(Path(directory).iterdir()), [])

    def test_an_unwritable_receipt_is_said_on_the_results_line_and_fails_no_wait(self):
        with tempfile.TemporaryDirectory() as directory:
            vm = self.guest(directory)
            vm.receipts = Path(directory)/'removed'
            vm.command.side_effect = self.polls_until(1)
            upgrade_suite.wait_for_api(vm)
            self.assertRegex(vm.waits[0], r'^api ready after \d+\.\d s \(budget 420 s\)$')
            self.assertRegex(vm.waits[1], r"^harness-events\.log write failed: FileNotFoundError\(")

    def test_login_and_schema_init_waits_note_their_elapsed_time(self):
        with tempfile.TemporaryDirectory() as directory:
            vm = self.guest(directory)
            vm.command.return_value = (0, '')
            upgrade_suite.wait_for_login(vm)
            boot_safety.wait_for_schema_init(vm)
            self.assertEqual(self.noted(vm), ['login ready after T s (budget 600 s)',
                                              'schema init ready after T s (budget 300 s)'])
            self.assertEqual([call.args[1] for call in vm.command.call_args_list], [600, 300])

    def test_readiness_waits_note_their_elapsed_time_and_host_budget(self):
        with tempfile.TemporaryDirectory() as directory:
            vm = self.guest(directory)
            vm.command.return_value = (0, '')
            with patch.object(acceptance, 'sql', return_value='ok'):
                acceptance.ready(vm)
                acceptance.ready(vm, budget=SLOW_BOOT_SECONDS)
            self.assertEqual(self.noted(vm), ['farm page ready after T s (budget 800 s)',
                                              f'farm page ready after T s (budget {acceptance.ready_host_timeout(900)} s)'])

    def test_console_waits_note_their_elapsed_time(self):
        with tempfile.TemporaryDirectory() as directory:
            vm = self.guest(directory)
            vm.command.return_value = (0, '12')
            marker = re.search(rb'(digest=[0-9a-f]{64})', COMMIT)
            with patch.object(vm, 'expect', return_value=marker) as expect:
                self.assertEqual(vm.console(before_console=FLOWS_COMMITTED), marker.groups())
                vm.console()
            with (patch.object(vm, 'launch'),
                  patch.object(vm, 'expect', return_value=re.search(rb'(READY)', b'READY'))):
                Guest.start(vm, inspection=True)
            self.assertEqual(self.noted(vm), ['console marker ready after T s (budget 900 s)',
                                              'login prompt ready after T s (budget 180 s)',
                                              'shell prompt ready after T s (budget 40 s)',
                                              'inspection console ready after T s (budget 180 s)'])
            # Each wait keeps the budget it had: the flows-commit marker its slow-boot budget.
            self.assertEqual([(call.args[0] is FLOWS_COMMITTED, call.args[1]) for call in expect.call_args_list],
                             [(True, 900), (False, 180), (False, 40)])

    def test_the_upgrade_gui_wait_notes_its_elapsed_time(self):
        with tempfile.TemporaryDirectory() as directory:
            vm = self.guest(directory)
            vm.command.return_value = (0, '')
            with (patch.object(upgrade_suite, 'checked', side_effect=['0.8.1', 'synthetic', '', '0.8.3', '']) as checked,
                  patch.object(upgrade_suite, 'sql', side_effect=['', 'a\nb\nc\nd', 'a\nb\nc\nd', 'ok']),
                  patch.object(upgrade_suite, 'wait_for_login'),
                  patch('radio_suite._api', return_value={'token': 'synthetic'})):
                upgrade_suite.run(vm, '0.8.1', '0.8.3')
            vm.reboot.assert_called_once_with()
            self.assertEqual(self.noted(vm), ['farm page ready after T s (budget 600 s)'])
            self.assertEqual(checked.call_args_list[2].args[2], 600)

    def test_the_held_boot_marker_wait_notes_its_elapsed_time(self):
        prior, zeros = (b'a'*64, b'20261121T050922Z'), (b'b'*64, b'20261121T050922Z')
        with tempfile.TemporaryDirectory() as directory:
            vm = self.guest(directory)
            vm.flows_receipt = Mock(side_effect=[prior, prior, zeros, zeros])
            with (patch.object(boot_safety, 'wait_for_schema_init'), patch.object(boot_safety, 'wait_for_api'),
                  patch.object(boot_safety, 'zero_live_flows', return_value=zeros),
                  patch.object(boot_safety, 'checked', side_effect=['', '', '', 'held for redeploy']) as checked):
                boot_safety.verify_missing_pristine_hold(vm)
            self.assertEqual(self.noted(vm), ['held boot marker ready after T s (budget 300 s)'])
            self.assertIn('HELD: Node-RED stopped.', checked.call_args_list[2].args[1])
            self.assertEqual(checked.call_args_list[2].args[2], 300)

    def test_the_account_case_api_poll_notes_its_elapsed_time(self):
        with tempfile.TemporaryDirectory() as directory:
            vm = self.guest(directory)

            def test(label, case, **_options):
                if label == 'First account and login':
                    case()

            with (patch.object(acceptance, 'checked', side_effect=['synthetic', '']) as checked,
                  patch.object(acceptance, 'sql', side_effect=['0', 'researcher']),
                  patch.object(acceptance, 'gui', return_value='{"mode":"setup"}')):
                acceptance.stock_cases(vm, SimpleNamespace(osi_version='0.8.3', chirpstack_version='4.12.1'),
                                       test, log=Mock())
            self.assertEqual(self.noted(vm), ['api ready after T s (budget 90 s)'])
            # The poll runs under checked's own timeout.
            self.assertEqual(len(checked.call_args_list[1].args), 2)

    def test_a_slow_api_wait_keeps_the_boot_timing_in_the_case_receipts(self):
        log = BootTimingTests().first_boot()
        with tempfile.TemporaryDirectory() as directory:
            vm = self.guest(directory)
            vm.log_from = 26

            def command(script, timeout):
                if 'seq 1 210' in script:
                    return 0, 'Sun Apr 13 16:51:09 2025'
                # Only this boot's syslog is read: the lines after the 26 the file held at the console.
                self.assertIn('tail -n +27', script)
                return 0, log

            vm.command.side_effect = command
            with patch('time.monotonic', side_effect=[100.0, 1017.3, 1017.4]):
                upgrade_suite.wait_for_api(vm)
            self.assertEqual(vm.waits, (
                'api ready after 917.3 s (budget 420 s)',
                'boot timing: first-boot work 16:43:47 to 16:48:26, osi-bootstrap 30 s, device import 154 s, '
                'Node-RED 4187 node load not finished, Node-RED 6749 node load 92 s, first /api/me answer 16:51:09'))
            self.assertEqual((vm.receipts/'boot-timing-3.syslog').read_text(), log + '\n')
            self.assertEqual((vm.receipts/'boot-timing-3.txt').read_text(), boot_timing.format_phases(
                boot_timing.boot_phases(log, 'Sun Apr 13 16:51:09 2025')) + '\n')

    def test_boot_timing_says_when_the_api_wait_printed_no_guest_clock(self):
        with tempfile.TemporaryDirectory() as directory:
            vm = self.guest(directory)
            vm.command.side_effect = [(0, ''), (0, BootTimingTests().first_boot())]
            with patch('time.monotonic', side_effect=[100.0, 1017.3, 1017.4]):
                upgrade_suite.wait_for_api(vm)
            # The wait passed, so /api/me answered; only its place on the guest clock is unknown.
            self.assertTrue(vm.waits[-1].endswith('Node-RED 6749 node load 92 s, no first /api/me answer; '
                                           'the API wait printed no guest clock'), vm.waits[-1])

    def test_an_api_wait_within_600_s_keeps_no_boot_timing(self):
        self.assertEqual(boot_timing.SLOW_API_SECONDS, 600)
        with tempfile.TemporaryDirectory() as directory:
            vm = self.guest(directory)
            vm.command.side_effect = self.polls_until(1)
            with (patch('time.monotonic', side_effect=[100.0, 700.0, 700.0]),
                  patch.object(boot_timing, 'keep') as keep):
                upgrade_suite.wait_for_api(vm)
            keep.assert_not_called()

    def test_boot_timing_that_cannot_be_read_is_said_on_the_results_line_and_fails_nothing(self):
        with tempfile.TemporaryDirectory() as directory:
            vm = self.guest(directory)
            vm.log_from = 0
            vm.command.side_effect = [(0, 'Sun Apr 13 16:51:09 2025'), TimeoutError('guest serial timed out')]
            with patch('time.monotonic', side_effect=[100.0, 1017.3, 1017.4]):
                upgrade_suite.wait_for_api(vm)
            self.assertEqual(vm.waits[-1], "boot timing not kept: TimeoutError('guest serial timed out')")
            self.assertEqual([path.name for path in Path(directory).iterdir()], ['harness-events.log'])
            self.assertIn('boot timing not kept', (vm.receipts/'harness-events.log').read_text())

    def test_a_slow_api_wait_on_a_private_guest_reads_nothing(self):
        with tempfile.TemporaryDirectory() as directory:
            vm = self.guest(directory, private=True)
            vm.command.side_effect = [(0, ''), AssertionError('a private guest is not read for timing')]
            with (patch('time.monotonic', side_effect=[100.0, 1017.3, 1017.4]),
                  patch.object(boot_timing, 'keep', wraps=boot_timing.keep) as keep):
                upgrade_suite.wait_for_api(vm)
            keep.assert_called_once()
            self.assertEqual(vm.waits, ())
            self.assertEqual(list(Path(directory).iterdir()), [])

    def suite(self, root, make, args, cases, upgrade):
        """run_cases over synthetic 0.8.0 and 0.8.1 fixtures, with every guest action but the notes patched."""
        for version in acceptance.UPGRADE_VERSIONS:
            folder = root/f'v{version}'
            folder.mkdir()
            (folder/'rpi5.img.gz').write_bytes(b'fixture')
            (folder/'SHA256SUMS').write_text(f'{hashlib.sha256(b"fixture").hexdigest()}  rpi5.img.gz\n')
        with (redirect_stdout(io.StringIO()), ExitStack() as stack,
              patch.object(acceptance, 'verified_archive', side_effect=lambda source, *_args, **_options: source),
              patch.object(acceptance, 'build_media'), patch.object(acceptance, 'ready'),
              patch.object(acceptance, 'upgrade', side_effect=upgrade)):
            for case in cases:
                stack.enter_context(case)
            status = acceptance.run_cases(args, root, root, root, 'recovery', False, guest_class=make)
        return status, (root/'results.log').read_text()

    def test_each_results_line_lists_the_boot_waits_noted_since_the_last_one(self):
        with tempfile.TemporaryDirectory() as directory:
            root = Path(directory)
            image = root/'rpi5.img.gz'
            image.write_bytes(b'fixture')
            made = []

            def console_waits(vm):
                suite_vm.note_wait(vm, 'login prompt ready after 17.3 s (budget 180 s)')
                suite_vm.note_wait(vm, 'shell prompt ready after 0.1 s (budget 40 s)')

            def make(_work, _image, *_args, **_options):
                folder = root/f'guest-{len(made)}'
                folder.mkdir()
                vm = self.guest(folder)
                if not made:
                    vm.start.side_effect = lambda: console_waits(vm)
                made.append(vm)
                return vm

            def stock(vm, _args, test, **_options):
                def case(label):
                    if label == 'Cold boot':
                        # The console waits were noted before this case began.
                        suite_vm.note_wait(vm, 'farm page ready after 433.9 s (budget 800 s)')
                        return 'OSI 0.8.3'
                    return 'synthetic'
                for label in acceptance.BASE_CASES[:-2]:
                    test(label, lambda label=label: case(label))

            def upgrade(vm, *_args, **_options):
                suite_vm.note_wait(vm, 'login prompt ready after 17.4 s (budget 180 s)')
                suite_vm.note_wait(vm, 'farm page ready after 500.1 s (budget 971 s)')

            args = SimpleNamespace(candidate=image, candidate_sha256=hashlib.sha256(b'fixture').hexdigest(),
                                   fixtures=root, qemu=None, ram=8, release_revision='a'*40, osi_version='0.8.3',
                                   flows_power_cut_only=False, customer_fixture_only=False,
                                   upgrade_boot_safety_only=False)
            status, result = self.suite(
                root, make, args,
                (patch.object(acceptance, 'stock_cases', side_effect=stock),
                 patch.object(acceptance, 'checked', return_value=PINNED_CAPABILITY),
                 patch.object(acceptance, 'cut_after_flows_patch', return_value='recovered'),
                 patch.object(acceptance, 'verify_zero_recovery'),
                 patch.object(acceptance, 'verify_missing_pristine_hold')), upgrade)
            self.assertEqual(status, 0, result)
            # A wait noted before a case began lands on the next results line; none is listed twice.
            self.assertRegex(result, r'(?m)^Cold boot\s+PASS\s+[\d.]+s\s+OSI 0\.8\.3; boot waits: login prompt ready after '
                                     r'17\.3 s \(budget 180 s\), shell prompt ready after 0\.1 s \(budget 40 s\), '
                                     r'farm page ready after 433\.9 s \(budget 800 s\)$')
            self.assertRegex(result, r'(?m)^First account and login\s+PASS\s+[\d.]+s\s+synthetic$')
            # A case without a receipt of its own: the waits follow the case time.
            self.assertRegex(result, r'(?m)^Upgrade 0\.8\.1\s+PASS\s+[\d.]+s\s+boot waits: login prompt ready after 17\.4 s '
                                     r'\(budget 180 s\), farm page ready after 500\.1 s \(budget 971 s\)$')
            self.assertEqual(result.count('login prompt ready after 17.3 s'), 1)
            self.assertEqual(result.count('shell prompt ready after 0.1 s'), 1)
            self.assertGreater(len(made), 3)

    def test_a_failed_results_line_keeps_its_error_and_lists_the_wait_that_ran_out(self):
        with tempfile.TemporaryDirectory() as directory:
            root = Path(directory)
            made = []

            def make(_work, _image, *_args, **_options):
                folder = root/f'guest-{len(made)}'
                folder.mkdir()
                vm = self.guest(folder)
                made.append(vm)
                return vm

            def cut(vm, first_boot):
                suite_vm.note_wait(vm, 'console marker ready after 296.0 s (budget 900 s)')
                if first_boot:
                    suite_vm.note_wait(vm, 'api ready after 512.3 s (budget 900 s)')
                    return 'clone held complete old or new flows and /api/me returned 401'
                raise RuntimeError('recovery left the candidate payload')

            def upgrade(vm, *_args, **_options):
                suite_vm.note_wait(vm, 'api not ready after 900.0 s (budget 900 s)')
                raise TimeoutError('guest serial timed out')

            args = SimpleNamespace(fixtures=root, candidate=None, qemu=None, ram=8,
                                   flows_power_cut_only=True, customer_fixture_only=False,
                                   upgrade_boot_safety_only=False, release_revision='a'*40, osi_version='0.8.3')
            status, result = self.suite(
                root, make, args, (patch.object(acceptance, 'cut_after_flows_patch', side_effect=cut),), upgrade)
            self.assertEqual(status, 1, result)
            self.assertRegex(result, r'(?m)^Flows cut on first boot\s+PASS\s+[\d.]+s\s+clone held complete old or new flows '
                                     r'and /api/me returned 401; boot waits: console marker ready after 296\.0 s '
                                     r'\(budget 900 s\), api ready after 512\.3 s \(budget 900 s\)$')
            self.assertRegex(result, r'(?m)^Flows cut on later boot\s+FAIL\s+[\d.]+s\s+recovery left the candidate payload; '
                                     r'boot waits: console marker ready after 296\.0 s \(budget 900 s\)$')
            self.assertRegex(result, r'(?m)^Flows cut after upgrade\s+FAIL\s+[\d.]+s\s+guest serial timed out; boot waits: '
                                     r'api not ready after 900\.0 s \(budget 900 s\)$')
            # A results line without a boot wait keeps its shape.
            self.assertRegex(result, r'(?m)^Flows cut on later boot \| REQUIRED \| FAIL \| FAIL \|  \| $')


class BootTimingTests(unittest.TestCase):
    """boot_timing on a guest syslog: the phases of a first boot, and of a boot still inside them."""

    RC = 'daemon.notice procd: /etc/rc.d/'
    NODE = 'daemon.info node['
    # The kept syslog of the 0.8.4 Pi 4 re-take's failed restart, recovered from the guest disk.
    KEPT = os.environ.get('OSI_RASPI5_TEST_BOOT_SYSLOG')

    @staticmethod
    def line(clock, text):
        hour, minute, second = (int(part) for part in clock.split(':'))
        return f'Sun Apr 13 {hour:02d}:{minute:02d}:{second:02d} 2025 ' + text

    def first_boot(self):
        """A first boot that finishes: osi-bootstrap, a Node-RED start it restarts, the device import, the API up."""
        return '\n'.join([
            self.line('16:41:56', 'user.notice node-red.init: persistent syslog sink already set (log_file=/data/log/osi-system.log)'),
            self.line('16:43:47', 'user.notice osi-bootstrap: waiting for ChirpStack gRPC...'),
            self.line('16:43:47', self.RC + 'S99osi-bootstrap: <!doctype html>'),
            self.line('16:44:02', self.RC + 'S99osi-bootstrap: [ 1/5 ] API key'),
            self.line('16:44:16', 'user.notice osi-bootstrap: bootstrap completed successfully'),
            self.line('16:44:17', 'user.notice osi-bootstrap: Node-RED restart requested after bootstrap'),
            self.line('16:44:48', self.NODE + '4187]: Welcome to Node-RED'),
            self.line('16:44:48', self.NODE + '4187]: ==================='),
            self.line('16:44:49', self.NODE + '4187]: 13 Apr 16:44:49 - [info] Node-RED version: v3.1.15'),
            self.line('16:45:27', self.NODE + '4187]: 13 Apr 16:45:27 - [info] Loading palette nodes'),
            self.line('16:45:32', 'daemon.info procd: Instance node-red::instance1 pid 4187 not stopped on SIGTERM, sending SIGKILL instead'),
            self.line('16:45:52', self.RC + 'S99zzz-lorawan-devices.init: 2025-04-13T16:45:52.0Z  INFO chirpstack: first'),
            self.line('16:46:50', self.NODE + '6749]: Welcome to Node-RED'),
            self.line('16:46:50', self.NODE + '6749]: ==================='),
            self.line('16:47:08', self.NODE + '6749]: 13 Apr 16:47:08 - [info] Loading palette nodes'),
            self.line('16:48:26', self.RC + 'S99zzz-lorawan-devices.init: 2025-04-13T16:48:26.0Z  INFO chirpstack: last'),
            self.line('16:48:40', self.NODE + '6749]: 13 Apr 16:48:40 - [info] Settings file  : /srv/node-red/settings.js'),
            self.line('16:48:41', self.NODE + '6749]: 13 Apr 16:48:41 - [info] Server now running at http://127.0.0.1:1880/'),
        ])

    FIRST_BOOT = {
        'log': {'lines': 18, 'first': '16:41:56', 'last': '16:48:41'},
        'first_boot_work': {'start': '16:43:47', 'end': '16:48:26', 'seconds': 279},
        'osi_bootstrap': {'start': '16:43:47', 'end': '16:44:17', 'seconds': 30},
        'device_import': {'start': '16:45:52', 'end': '16:48:26', 'seconds': 154},
        'node_red': [
            {'pid': '4187', 'started': '16:44:48', 'node_load_start': '16:45:27', 'node_load_end': None,
             'node_load_seconds': None, 'listening': None},
            {'pid': '6749', 'started': '16:46:50', 'node_load_start': '16:47:08', 'node_load_end': '16:48:40',
             'node_load_seconds': 92, 'listening': '16:48:41'},
        ],
        'api_answer': None,
    }

    def test_a_finished_first_boot_is_timed_from_its_syslog(self):
        self.assertEqual(boot_timing.boot_phases(self.first_boot()), self.FIRST_BOOT)
        # The guest clock at the first 401 comes from the API wait, which alone observes it.
        phases = dict(self.FIRST_BOOT, api_answer='16:51:09')
        self.assertEqual(boot_timing.boot_phases(self.first_boot(), 'Sun Apr 13 16:51:09 2025'), phases)
        self.assertEqual(boot_timing.format_phases(phases).splitlines(), [
            'guest syslog: 18 lines, 16:41:56 to 16:48:41',
            'first-boot work: 16:43:47 to 16:48:26 (279 s)',
            '  osi-bootstrap: 16:43:47 to 16:44:17 (30 s)',
            '  device import: 16:45:52 to 16:48:26 (154 s)',
            'Node-RED 4187: started 16:44:48, node load from 16:45:27, not finished in this log',
            'Node-RED 6749: started 16:46:50, node load 16:47:08 to 16:48:40 (92 s), API listening 16:48:41',
            'first /api/me answer: 16:51:09 (guest clock, read by the API wait)',
        ])
        self.assertEqual(boot_timing.summarize(phases), (
            'first-boot work 16:43:47 to 16:48:26, osi-bootstrap 30 s, device import 154 s, '
            'Node-RED 4187 node load not finished, Node-RED 6749 node load 92 s, first /api/me answer 16:51:09'))

    def test_a_log_that_ends_inside_the_first_boot_work_says_so(self):
        lines = self.first_boot().splitlines()
        cut = next(n for n, line in enumerate(lines) if '6749]: 13 Apr 16:47:08' in line)
        log = '\n'.join([*lines[:cut + 1], self.line('16:48:26', self.RC + 'S99zzz-lorawan-devices.init: INFO last')])
        phases = boot_timing.boot_phases(log)
        self.assertEqual(phases['first_boot_work'], {'start': '16:43:47', 'end': '16:48:26', 'seconds': 279})
        self.assertEqual(phases['node_red'][1], {'pid': '6749', 'started': '16:46:50', 'node_load_start': '16:47:08',
                                                  'node_load_end': None, 'node_load_seconds': None, 'listening': None})
        text = boot_timing.format_phases(phases)
        self.assertIn('Node-RED 6749: started 16:46:50, node load from 16:47:08, not finished in this log', text)
        self.assertIn('first /api/me answer: none in this evidence', text)
        self.assertEqual(boot_timing.summarize(phases), (
            'first-boot work 16:43:47 to 16:48:26, osi-bootstrap 30 s, device import 154 s, '
            'Node-RED 4187 node load not finished, Node-RED 6749 node load not finished, no first /api/me answer'))

    def test_a_bootstrap_that_never_ends_is_not_finished(self):
        lines = self.first_boot().splitlines()
        open_ = [line for line in lines if ' osi-bootstrap: ' in line and 'requested after bootstrap' not in line
                 and 'completed successfully' not in line]
        phases = boot_timing.boot_phases('\n'.join(open_))
        self.assertEqual(phases['osi_bootstrap'], {'start': '16:43:47', 'end': None, 'seconds': None})
        self.assertEqual(phases['first_boot_work'], {'start': '16:43:47', 'end': None, 'seconds': None})
        self.assertEqual(phases['node_red'], [])
        self.assertIn('first-boot work: 16:43:47, not finished in this log', boot_timing.format_phases(phases))
        self.assertEqual(boot_timing.summarize(phases), (
            'first-boot work 16:43:47, not finished, osi-bootstrap not finished, Node-RED did not start in the log, '
            'no first /api/me answer'))

    def test_an_ordinary_boot_has_no_first_boot_work(self):
        lines = [line for line in self.first_boot().splitlines()
                 if 'osi-bootstrap' not in line and 'lorawan-devices' not in line and '4187' not in line]
        phases = boot_timing.boot_phases('\n'.join(lines), 'Sun Apr 13 16:49:02 2025')
        self.assertIsNone(phases['first_boot_work'])
        self.assertIsNone(phases['osi_bootstrap'])
        self.assertIsNone(phases['device_import'])
        self.assertEqual([run['pid'] for run in phases['node_red']], ['6749'])
        self.assertEqual(boot_timing.format_phases(phases).splitlines(), [
            'guest syslog: 6 lines, 16:41:56 to 16:48:41',
            'first-boot work: none in this log',
            'Node-RED 6749: started 16:46:50, node load 16:47:08 to 16:48:40 (92 s), API listening 16:48:41',
            'first /api/me answer: 16:49:02 (guest clock, read by the API wait)',
        ])
        # An answer the wait did not read in the syslog clock format is not placed on the timeline.
        self.assertIsNone(boot_timing.boot_phases('\n'.join(lines), 'Thu Nov 26 00:01:02 CET 2026')['api_answer'])

    def test_times_are_read_across_the_hour_and_past_midnight(self):
        log = '\n'.join([
            self.line('23:59:50', 'user.notice osi-bootstrap: waiting for ChirpStack gRPC...'),
            self.line('00:00:20', 'user.notice osi-bootstrap: bootstrap failed, will retry next boot'),
            self.line('00:00:22', self.NODE + '99]: Welcome to Node-RED'),
            self.line('00:00:24', self.NODE + '99]: 14 Apr 00:00:24 - [info] Loading palette nodes'),
            self.line('00:00:59', self.NODE + '99]: 14 Apr 00:00:59 - [info] Settings file  : /srv/node-red/settings.js'),
        ])
        phases = boot_timing.boot_phases(log)
        self.assertEqual(phases['osi_bootstrap']['seconds'], 30)
        self.assertEqual(phases['node_red'][0]['node_load_seconds'], 35)
        self.assertEqual(phases['first_boot_work'], {'start': '23:59:50', 'end': '00:00:20', 'seconds': 30})

    def test_the_helper_reads_a_kept_log_by_hand(self):
        with tempfile.TemporaryDirectory() as directory:
            log = Path(directory)/'syslog'
            log.write_text(self.first_boot())
            for extra, expected in (([], 'first /api/me answer: none in this evidence'),
                                    (['--api-answer', 'Sun Apr 13 16:51:09 2025'],
                                     'first /api/me answer: 16:51:09 (guest clock, read by the API wait)')):
                with self.subTest(extra=extra):
                    done = subprocess.run(['python3', str(boot_timing.__file__), str(log), *extra],
                                          capture_output=True, text=True)
                    self.assertEqual(done.returncode, 0, done.stderr)
                    self.assertIn('osi-bootstrap: 16:43:47 to 16:44:17 (30 s)', done.stdout)
                    self.assertIn(expected, done.stdout.splitlines())
            done = subprocess.run(['python3', str(boot_timing.__file__), str(log), '--json'],
                                  capture_output=True, text=True)
            self.assertEqual(json.loads(done.stdout), self.FIRST_BOOT)

    @unittest.skipUnless(KEPT, 'set OSI_RASPI5_TEST_BOOT_SYSLOG to the kept syslog of the 0.8.4 Pi 4 re-take')
    def test_the_kept_syslog_of_the_pi4_retake_names_where_the_restart_boot_stood(self):
        # The 0.8.4 re-take, Pi 4 run 2: the restart after a factory first-boot cut
        # ran past the 420 s API wait. Its disk holds the boot up to the device import.
        phases = boot_timing.boot_phases(Path(self.KEPT).read_text(errors='replace'))
        self.assertEqual(phases['log'], {'lines': 4113, 'first': '16:42:19', 'last': '16:48:26'})
        self.assertEqual(phases['osi_bootstrap'], {'start': '16:43:47', 'end': '16:44:17', 'seconds': 30})
        # The device import began two seconds after the bootstrap asked for the Node-RED
        # restart and was still writing when the log ends.
        self.assertEqual(phases['device_import'], {'start': '16:44:19', 'end': '16:48:26', 'seconds': 247})
        self.assertEqual(phases['first_boot_work'], {'start': '16:43:47', 'end': '16:48:26', 'seconds': 279})
        self.assertEqual([(run['pid'], run['started'], run['node_load_start'], run['node_load_end'])
                          for run in phases['node_red']],
                         [('4187', '16:44:48', '16:45:27', None), ('6749', '16:46:50', '16:47:08', None)])
        self.assertIsNone(phases['api_answer'])
        self.assertEqual(boot_timing.summarize(phases), (
            'first-boot work 16:43:47 to 16:48:26, osi-bootstrap 30 s, device import 247 s, '
            'Node-RED 4187 node load not finished, Node-RED 6749 node load not finished, no first /api/me answer'))


class BootTimingReadTests(unittest.TestCase):
    """The guest read behind the automatic boot timing: this boot's phase lines, small enough for the console."""

    RC = 'daemon.notice procd: /etc/rc.d/S99zzz-lorawan-devices.init: '
    PREVIOUS = [BootTimingTests.line('16:10:00', 'user.notice osi-bootstrap: waiting for ChirpStack gRPC...'),
                BootTimingTests.line('16:10:01', 'daemon.info node[11]: Welcome to Node-RED'),
                BootTimingTests.line('16:10:02', 'user.notice node-red.init: persistent syslog sink enabled')]
    BOOT = [BootTimingTests.line('16:43:18', 'user.notice node-red.init: persistent syslog sink already set'),
            BootTimingTests.line('16:43:47', 'user.notice osi-bootstrap: waiting for ChirpStack gRPC...'),
            BootTimingTests.line('16:45:52', RC + 'INFO first'),
            BootTimingTests.line('16:46:00', RC + 'INFO second'),
            BootTimingTests.line('16:46:10', RC + 'INFO third'),
            BootTimingTests.line('16:46:50', 'daemon.info node[6749]: Welcome to Node-RED'),
            BootTimingTests.line('16:48:26', RC + 'INFO last'),
            BootTimingTests.line('16:47:08', 'daemon.info node[6749]: 13 Apr 16:47:08 - [info] Loading palette nodes')]
    # Each phase line once, and of each run of import lines the first and the last.
    PHASE_LINES = [BOOT[1], BOOT[2], BOOT[4], BOOT[5], BOOT[6], BOOT[7]]

    def read(self, current, rotated, first, *, ring=''):
        script = boot_timing.read_script(first).replace(boot_timing.SYSLOG, quote(str(current)))
        done = subprocess.run(['sh', '-c', ring + script], capture_output=True, text=True)
        self.assertEqual(done.returncode, 0, done.stderr)
        return done.stdout.splitlines()

    def test_the_read_starts_after_the_lines_the_console_found_and_keeps_the_import_ends(self):
        with tempfile.TemporaryDirectory() as directory:
            current = Path(directory)/'osi-system.log'
            current.write_text('\n'.join([*self.PREVIOUS, *self.BOOT]) + '\n')
            self.assertEqual(self.read(current, None, len(self.PREVIOUS) + 1), self.PHASE_LINES)

    def test_a_log_rotated_since_the_console_answers_reads_on_from_the_rotated_file(self):
        with tempfile.TemporaryDirectory() as directory:
            current = Path(directory)/'osi-system.log'
            rotated = Path(directory)/'osi-system.log.old'
            # The console found 5 lines; the import then filled the file and logd started a new one.
            rotated.write_text('\n'.join([*self.PREVIOUS, *self.BOOT[:6]]) + '\n')
            current.write_text('\n'.join(self.BOOT[6:]) + '\n')
            self.assertEqual(self.read(current, rotated, 5), self.PHASE_LINES)

    def test_a_guest_without_a_persistent_syslog_is_read_from_the_ring(self):
        with tempfile.TemporaryDirectory() as directory:
            ring = 'logread() {\n' + ''.join(f'  echo {quote(line)}\n' for line in (self.BOOT[1], self.BOOT[7])) + '}\n'
            self.assertEqual(self.read(Path(directory)/'osi-system.log', None, 1, ring=ring), [self.BOOT[1], self.BOOT[7]])

    def test_the_console_probe_reads_the_persistent_log_line_count(self):
        self.assertEqual(suite_vm.line_count('27'), 27)
        # No persistent syslog on the guest: the read starts at the first line.
        self.assertEqual(suite_vm.line_count(''), 0)
        self.assertEqual(suite_vm.line_count('wc: read error'), 0)
        self.assertIn('-f /data/log/osi-system.log', Guest.LOG_COUNT)


if __name__ == '__main__':
    unittest.main()
