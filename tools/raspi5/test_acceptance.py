"""Host-only tests for the Pi 5 acceptance runner."""
from concurrent.futures import ThreadPoolExecutor
from contextlib import closing, nullcontext, redirect_stderr, redirect_stdout
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
from unittest.mock import Mock, patch

import acceptance
from archives import verified_archive
import boot_safety
import customer_fixture
import minimal_flows
import radio_suite
import run
from suite_vm import FLOWS_COMMITTED, SLOW_BOOT_SECONDS, Guest, external_path
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
        self.assertEqual(output.getvalue().strip(), (
            f'{radio_suite.VALVE} valve open attempt 1/3 (open, queue item -): failed: downlink before receive window | '
            'downlink: MISSING (FPort 2 payload 4101 received 0.00 s after the GUI open, before the receive window)'))

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
        """A refusal at enqueue on every window fails after the bounded attempts; none is masked by a retry."""
        row = self.expectation_row('e1', self.QUEUE)
        case = self.valve_case(
            [[None]] * 3, error='open command not received after 3 attempts',
            frames=[self.window(self.refused(n), n) for n in (1, 2, 3)], edges=['', row, row, row],
            held=[self.HELD, self.TAKEN, self.TAKEN], after=[self.TAKEN] * 3)
        case.gui_open.assert_called_once()
        self.assertEqual(self.sent(case), [b'trigger'] * 3)
        self.assertEqual(case.clock(), 152 + 2 * 150)
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
            'enqueue; Concentratord dropped it as too old, 19.9 ms after its TX time; queue item q1 left ChirpStack\'s queue without an OK ack')
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
                                  'RX1 +1 s with 140.5 ms lead at enqueue; no TX, refusal or drop logged for it; '
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

    def test_another_items_presence_in_the_queue_after_a_delivery_does_not_fail_the_case(self):
        """Only the attempt's own item still being queued disagrees with the gateway's OK ack."""
        row = self.expectation_row('e1', self.QUEUE)
        case = self.valve_case([[1.0]], edges=['', row], held=[self.HELD], after=['old|3|4101|0|0|'],
                               frames=[self.window(self.scheduled(1), 1), self.window('', 2)])
        self.assertEqual(case.result, 'WM1302 model delivered=2, Concentratord frames received=2')
        self.assertIn('concentratord: ' + self.BINDS + '; queue after: ChirpStack queue after the attempt: item old '
                      'FPort 3 data 4101 is_pending 0 is_encrypted 0', case.lines[0])
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


if __name__ == '__main__':
    unittest.main()
