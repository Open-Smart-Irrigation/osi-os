"""Host checks for Pi 4 wiring and required candidate results."""
from contextlib import redirect_stdout
import hashlib
import io
import os
from pathlib import Path
import re
import struct
import subprocess
import tempfile
from types import SimpleNamespace
import unittest
from unittest.mock import Mock, call, patch

import pi4
from pi4 import DTB, Pi4, acceptance, boot_config
from minimal_flows import ATOMIC_PUBLISH, CUT_RECEIPT
from suite_vm import INSPECTION_INIT, SLOW_BOOT_SECONDS, Guest
import upgrade_suite


def write_upgrade_fixtures(root, data):
    digest = hashlib.sha256(data).hexdigest()
    for version in acceptance.UPGRADE_VERSIONS:
        folder = root/f'v{version}'
        folder.mkdir()
        (folder/'rpi4.img.gz').write_bytes(data)
        (folder/'SHA256SUMS').write_text(f'{digest}  rpi4.img.gz\n')


def api_poll_answer(answer_at):
    """A guest command stand-in that runs the API poll on the host; the first 401 comes at poll `answer_at`."""
    def command(script, timeout):
        # With fast curls and two seconds between polls, each poll stands for two seconds.
        fixture = (f'polls=0\ncurl() {{ [ "$polls" -ge {answer_at - 1} ] && printf 401; }}\n'
                   'sleep() { [ "$1" = 2 ] || exit 2; polls=$((polls + 1)); }\n')
        result = subprocess.run(['sh', '-c', fixture + script], capture_output=True, text=True)
        return result.returncode, result.stdout.strip()
    return command


class Pi4Tests(unittest.TestCase):
    def test_release_gate_fails_when_both_capability_probes_miss_a_renamed_helper(self):
        with tempfile.TemporaryDirectory() as directory:
            root = Path(directory)
            revision = 'a' * 40
            (root/'SERVED-FROM.txt').write_text(revision)
            init = root/'feeds/chirpstack-openwrt-feed/apps/node-red/files/node-red.init'
            init.parent.mkdir(parents=True)
            init.write_text('function persistRenamedHold(stamp, reason) {\n')
            image = root/'rpi4.img.gz'
            image.write_bytes(b'pi4 image')
            image_digest = hashlib.sha256(image.read_bytes()).hexdigest()
            write_upgrade_fixtures(root, image.read_bytes())

            def stock(_guest, _args, record, **_options):
                for label in acceptance.BASE_CASES[:-2]:
                    record(label, lambda: None)

            with (redirect_stdout(io.StringIO()),
                  patch.object(acceptance, 'external_path', side_effect=lambda path, **_: path),
                  patch.object(acceptance, 'stock_cases', side_effect=stock),
                  patch.object(acceptance, 'checked', return_value=''),
                  patch.object(acceptance, 'ready'), patch.object(acceptance, 'build_media'),
                  patch.object(acceptance, 'upgrade')):
                status = acceptance.main([
                    '--candidate', str(image), '--candidate-sha256', image_digest,
                    '--osi-version', '0.8.3', '--chirpstack-version', '4.12.1',
                    '--release', str(root), '--release-revision', revision,
                    '--fixtures', str(root), '--run-root', str(root),
                ], board='pi4', guest_class=Mock(), memory=(2,))
            result = next(root.glob('pi4-acceptance-*/results.log')).read_text()
            self.assertEqual(status, 1, result)
            self.assertIn('Candidate acceptance: FAIL', result)
            self.assertIn('Case totals: 0 passed / 21 required', result)
            self.assertNotIn(' | N/A | ', result)
            for label in acceptance.RECOVERY_CASES + acceptance.MINIMAL_CASES:
                self.assertIn(f'{label} | REQUIRED | NOT RUN | FAIL', result)

    def test_release_counts_all_18_and_rejects_a_skipped_case(self):
        for skip in (False, True):
            with self.subTest(skip=skip), tempfile.TemporaryDirectory() as directory:
                root = Path(directory)
                write_upgrade_fixtures(root, b'pi4 fixture')
                args = SimpleNamespace(fixtures=root, candidate=None, qemu=None, ram=2,
                                       osi_version='0.8.3', release_revision='a'*40,
                                       flows_power_cut_only=False, upgrade_boot_safety_only=False,
                                       customer_fixture_only=False, historical=False)

                def stock(_guest, _args, record, **_options):
                    for label in acceptance.BASE_CASES[:-2]:
                        record(label, lambda: None)

                def flow_cut(_guest, first_boot):
                    if skip and first_boot:
                        raise unittest.SkipTest('case skipped by workload')

                with (redirect_stdout(io.StringIO()),
                      patch.object(acceptance, 'external_path', side_effect=lambda path, **_: path),
                      patch.object(acceptance, 'stock_cases', side_effect=stock),
                      patch.object(acceptance, 'checked', return_value='function persistFlowHold('),
                      patch.object(acceptance, 'ready'), patch.object(acceptance, 'build_media'),
                      patch.object(acceptance, 'upgrade'), patch.object(acceptance, 'verify_zero_recovery'),
                      patch.object(acceptance, 'verify_missing_pristine_hold'),
                      patch.object(acceptance, 'cut_after_flows_patch', side_effect=flow_cut)):
                    status = acceptance.run_cases(args, root, root, root, 'recovery', False,
                                                  board='pi4', guest_class=Mock())
                result = (root/'results.log').read_text()
                self.assertEqual(status, int(skip), result)
                self.assertIn(f'Case totals: {18 - int(skip)} passed / 18 required', result)
                for label in acceptance.MINIMAL_CASES:
                    self.assertIn(f'{label} | N/A | NOT RUN | N/A | persistFlowHold present in factory image init'
                                  f' | {", ".join(acceptance.RECOVERY_CASES)}', result)
                if skip:
                    self.assertRegex(result, r'Flows cut on first boot\s+FAIL.*case skipped')

    def test_minimal_candidate_uses_pi4_probe_and_requires_all_three_cuts(self):
        for omit in (False, True):
            with self.subTest(omit=omit), tempfile.TemporaryDirectory() as directory:
                root = Path(directory)
                write_upgrade_fixtures(root, b'pi4 fixture')
                init = root/acceptance.INIT
                init.parent.mkdir(parents=True)
                init.write_text(ATOMIC_PUBLISH + '\n')
                candidate_payload = acceptance.FactoryPayload(hashlib.sha256(init.read_bytes()).hexdigest(),
                                                              'b'*64, 'c'*64)
                probe_payload = acceptance.FactoryPayload('d'*64, candidate_payload.writer, candidate_payload.flows)
                image = root/'factory.img.gz'
                image.write_bytes(b'factory')
                args = SimpleNamespace(fixtures=root, candidate=image, qemu=None, ram=2,
                                       osi_version='0.8.3', release_revision='a'*40,
                                       flows_power_cut_only=False, upgrade_boot_safety_only=False,
                                       customer_fixture_only=False, historical=False,
                                       candidate_sha256=hashlib.sha256(b'factory').hexdigest(),
                                       openwrt_host_tools=root)

                def stock(_guest, _args, record, **_options):
                    for label in acceptance.BASE_CASES[:-2]:
                        record(label, lambda: None)

                factory_cases = dict(acceptance.MINIMAL_FACTORY_CASES)
                if omit:
                    del factory_cases['before-dir-sync']
                guest = Mock()
                capability = acceptance.flows_capability(ATOMIC_PUBLISH)
                self.assertEqual(capability, 'minimal')
                def derive(archive, _release, _probe, output, _tools):
                    self.assertNotEqual(archive, image)
                    self.assertEqual(archive.read_bytes(), b'factory')
                    output.write_bytes(b'derived from ' + archive.read_bytes())
                    return hashlib.sha256(output.read_bytes()).hexdigest()

                with (redirect_stdout(io.StringIO()),
                      patch.object(acceptance, 'derive_probe_image', side_effect=derive) as derivation,
                      patch.object(acceptance, 'MINIMAL_FACTORY_CASES', factory_cases),
                      patch.object(acceptance, 'external_path', side_effect=lambda path, **_: path),
                      patch.object(acceptance, 'stock_cases', side_effect=stock),
                      patch.object(acceptance, 'prepare_probe_release', return_value='d'*64),
                      patch.object(acceptance, 'checked', return_value=ATOMIC_PUBLISH),
                      patch.object(acceptance, 'read_factory_payload',
                                   side_effect=[candidate_payload, probe_payload, probe_payload]),
                      patch.object(acceptance, 'ready'), patch.object(acceptance, 'wait_for_api'),
                      patch.object(acceptance, 'verify_disk'), patch.object(acceptance, 'build_media'),
                      patch.object(acceptance, 'upgrade') as upgrade):
                    status = acceptance.run_cases(args, root, root, root, capability, False,
                                                  board='pi4', guest_class=guest)
                self.assertEqual(status, int(omit))
                self.assertEqual(guest.call_args_list[0].args[1], derivation.call_args.args[0])
                self.assertEqual(sum(call.args[1] == derivation.call_args.args[3] for call in guest.call_args_list), 2 - int(omit))
                self.assertEqual(upgrade.call_args.kwargs['cut_at'], CUT_RECEIPT)
                result = (root/'results.log').read_text()
                self.assertIn(f'Case totals: {13 - int(omit)} passed / 13 required', result)
                for label in acceptance.FLOWS_CASES + acceptance.BOOT_SAFETY_CASES:
                    self.assertIn(f'{label} | N/A | NOT RUN | N/A | persistFlowHold absent and minimal atomic '
                                  f'publication present in factory image init | {", ".join(acceptance.MINIMAL_CASES)}', result)
                for label in acceptance.MINIMAL_CASES:
                    outcome = 'NOT RUN | FAIL' if omit and label.endswith('before directory fsync') else 'PASS | PASS'
                    self.assertIn(f'{label} | REQUIRED | {outcome}', result)

    def test_historical_flag_and_env_cannot_override_factory_capability(self):
        with tempfile.TemporaryDirectory() as directory:
            root = Path(directory)
            revision = 'a' * 40
            init = root/'feeds/chirpstack-openwrt-feed/apps/node-red/files/node-red.init'
            init.parent.mkdir(parents=True)
            init.write_text(ATOMIC_PUBLISH + '\n')
            (root/'SERVED-FROM.txt').write_text(revision)
            image = root/'rpi4.img.gz'
            image.write_bytes(b'pi4 image')
            digest = hashlib.sha256(image.read_bytes()).hexdigest()
            guest = Mock()
            with (redirect_stdout(io.StringIO()),
                  patch.dict(os.environ, {'OSI_FLOWS_CAPABILITY': 'unsupported'}),
                  patch.object(acceptance, 'external_path', side_effect=lambda path, **_: path),
                  patch.object(acceptance, 'checked', return_value=ATOMIC_PUBLISH) as checked,
                  patch.object(acceptance, 'stock_cases') as stock):
                status = acceptance.main([
                    '--historical', '--candidate', str(image), '--candidate-sha256', digest,
                    '--osi-version', '0.8.3', '--chirpstack-version', '4.12.1',
                    '--release', str(root), '--release-revision', revision,
                    '--fixtures', str(root), '--run-root', str(root),
                ], board='pi4', guest_class=guest, memory=(2,))
            self.assertEqual(status, 1)
            checked.assert_called_once_with(guest.return_value, 'cat /rom/etc/init.d/node-red')
            stock.assert_not_called()
            result = next(root.glob('pi4-acceptance-*/results.log')).read_text()
            self.assertIn('Factory image flows capability: minimal', result)
            self.assertIn('Historical diagnostics: FAIL', result)
            self.assertNotIn(' | N/A | ', result)
            self.assertNotIn('Candidate acceptance:', result)

    def test_selects_32_bit_kernel_and_ignores_pi5_config(self):
        config = b'[pi5]\nkernel=kernel_2712.img\n[pi4]\ninclude distroconfig.txt\n'
        distro = b'[pi4]\nos_prefix=armv7/\n'

        def read(args, **_options):
            return {'::config.txt': config, '::distroconfig.txt': distro}[args[-1]]

        with (patch.object(boot_config.subprocess, 'check_output', side_effect=read),
              patch.object(boot_config.subprocess, 'run') as run):
            run.return_value.returncode = 0
            work = Path('work')
            boot_config.load('boot.fat', work, 'dtmerge', board='pi4')
        copied = [call.args[0][-2:] for call in run.call_args_list if call.args[0][0] == 'mcopy']
        self.assertEqual(copied, [['::armv7/kernel7l.img', work/'kernel.img'],
                                  [f'::armv7/{DTB}', work/DTB],
                                  ['::armv7/cmdline.txt', work/'cmdline.txt']])

    def test_shell_boot_uses_a_separate_dtb_and_clone(self):
        with tempfile.TemporaryDirectory() as directory:
            vm = Pi4.__new__(Pi4)
            vm.work = Path(directory)
            vm.qemu = vm.work/'qemu-system-aarch64'
            vm.ram = 2
            vm.receipts = vm.work/'receipts'
            vm.receipts.mkdir()
            vm.boots = 4
            vm.private = False
            (vm.work/DTB).write_bytes(b'dtb')
            cmdline = f'root=/dev/mmcblk0p2 {vm.console_args} init=/bin/sh -- -c "{INSPECTION_INIT}"'
            disk = 'if=sd,format=raw,file=inspect.img,cache=none'
            with patch('pi4.subprocess.run') as run:
                args = vm.qemu_args(5, disk, cmdline, True)
                run.assert_called_once()
                self.assertEqual(run.call_args.args[0][-4:],
                                 [vm.work/'inspect.dtb', '/chosen', 'bootargs', cmdline])
                with self.assertRaisesRegex(ValueError, 'command-line limit'):
                    vm.qemu_args(5, disk, 'x' * 1024, True)
            self.assertIn(disk, args)
            self.assertTrue(any(str(arg).startswith('loader,file=inspect.dtb,') for arg in args))
            self.assertEqual((vm.work/DTB).read_bytes(), b'dtb')
            self.assertEqual(args[args.index('-nic') + 1], f'socket,fd=5,mac={pi4.Ethernet.MAC}')
            expected = (f'device tree {pi4.Ethernet.NODE} local-mac-address {pi4.Ethernet.MAC}: expected provisional EUI '
                        f'{pi4.provisional_eui(pi4.Ethernet.MAC)}')
            with patch('pi4.subprocess.run'):
                vm.qemu_args(5, disk, cmdline, False)
            self.assertEqual((vm.receipts/'gateway-identity.log').read_text().splitlines(), [
                f'boot=4 inspection launch: {expected} (not observed)',
                f'boot=4 launch: {expected} (not observed until the console answers)'])

    def test_qemu_argv_carries_a_fixed_mac_distinct_from_the_pi5_model(self):
        """The fixed MAC reaches QEMU on -nic and is not QEMU's default, which the Pi 5 model keeps."""
        with tempfile.TemporaryDirectory() as directory:
            vm = Pi4.__new__(Pi4)
            vm.work, vm.qemu, vm.ram = Path(directory), Path(directory)/'qemu-system-aarch64', 2
            vm.receipts, vm.boots, vm.private = vm.work, 1, True
            (vm.work/DTB).write_bytes(b'dtb')
            with patch('pi4.subprocess.run'):
                args = vm.qemu_args(5, 'disk', 'cmdline', False)
            self.assertRegex(args[args.index('-nic') + 1], r'^socket,fd=5,mac=([0-9a-f:]{17})$')
            self.assertNotEqual(args[args.index('-nic') + 1], 'socket,fd=5,mac=52:54:00:12:34:56')
            self.assertEqual(args[args.index('-M') + 1], 'raspi4b')

    def test_launcher_pins_the_ethernet_mac_into_the_device_tree(self):
        """load_boot writes the fixed MAC as six bytes into the shipped DTB's Ethernet node."""
        self.assertEqual(pi4.Ethernet.MAC, '52:54:00:27:11:04')
        self.assertEqual(pi4.Ethernet.NODE, '/scb/ethernet@7d580000')
        with tempfile.TemporaryDirectory() as directory:
            work = Path(directory)
            stub = bytearray(256)
            struct.pack_into('<I', stub, 0xf0, 0x5afe570b)
            (work/'armstub8-32-gic.bin').write_bytes(stub)
            with (patch.object(pi4.subprocess, 'check_output', return_value=b'[all]\n'),
                  patch.object(pi4.subprocess, 'run') as run, patch.object(pi4.shutil, 'which', return_value=None)):
                Pi4.load_boot('boot.fat', work, work/'dtmerge', quiet=True)
            fdtput = work/'fdtput'
            writes = [c.args[0] for c in run.call_args_list if c.args[0] and c.args[0][0] == fdtput]
            self.assertEqual(writes.count([fdtput, '-t', 'bx', work/DTB, pi4.Ethernet.NODE, 'local-mac-address',
                                           *pi4.Ethernet.MAC.split(':')]), 1)
            self.assertIn([fdtput, '-t', 's', work/DTB, '/soc/serial@7e201000', 'status', 'okay'], writes)

    def test_each_boot_records_the_guest_mac_and_its_derived_eui(self):
        """The console read notes what the kernel gave eth0 and the EUI derived from it; private guests keep no file."""
        answer = (0, 'mac-eth0=52:54:00:27:11:04\nmac-br-lan=52:54:00:27:11:04\nrandom-mac=0\nuci-eui=\nuci-source=\n')
        with tempfile.TemporaryDirectory() as directory:
            vm = Pi4.__new__(Pi4)
            vm.receipts, vm.boots, vm.private = Path(directory), 7, False
            with patch.object(Guest, 'command', side_effect=[(0, ''), answer]) as command:
                vm.console_ready()
            self.assertEqual(command.call_args_list[0].args[0], Guest.LOG_CHECKPOINT)
            script = command.call_args_list[1].args[0]
            for needle in ('/sys/class/net/$interface/address', 'using random Ethernet MAC', 'osi-server.cloud.device_eui'):
                self.assertIn(needle, script)
            self.assertEqual((vm.receipts/'gateway-identity.log').read_text(), (
                f'boot=7 eth0 52:54:00:27:11:04, observed provisional EUI {pi4.provisional_eui(pi4.Ethernet.MAC)}; '
                'random-MAC warnings 0; uci device_eui - source -\n'))
            vm.private, vm.boots = True, 8
            with patch.object(Guest, 'command', side_effect=[(0, ''), answer]):
                vm.console_ready()
            self.assertEqual((vm.receipts/'gateway-identity.log').read_text().count('\n'), 1)

    def test_identity_script_counts_kernel_warnings_without_doubling_zero(self):
        """The guest script through sh: no warning counts 0 once; a dmesg that fails says so."""
        stubs = ('cat() { case "$1" in */eth0/address) echo 52:54:00:27:11:04;; esac; }\n'
                 'uci() { return 1; }\n')
        for dmesg, expected in (('dmesg() { echo "bcmgenet fd580000.ethernet: using random Ethernet MAC"; }', 'random-mac=1'),
                                ('dmesg() { :; }', 'random-mac=0'),
                                ('dmesg() { return 1; }', 'random-mac=unreadable')):
            with self.subTest(expected=expected):
                result = subprocess.run(['sh', '-c', stubs + dmesg + '\n' + pi4.IDENTITY],
                                        capture_output=True, text=True)
                self.assertEqual(result.returncode, 0, result.stderr)
                self.assertEqual(result.stdout.splitlines()[:2], ['mac-eth0=52:54:00:27:11:04', expected])

    def test_board_check_requires_the_fixed_mac(self):
        """Cold boot fails unless eth0 carries the fixed MAC and the kernel did not fall back to a random one."""
        for mac, warnings, fails in ((pi4.Ethernet.MAC, '0', False), (pi4.Ethernet.MAC, 'unreadable', False),
                                     ('52:54:00:aa:bb:cc', '0', True), (pi4.Ethernet.MAC, '1', True)):
            with self.subTest(mac=mac, warnings=warnings):
                vm = Mock()
                vm.command.return_value = (0, f'mac-eth0={mac}\nrandom-mac={warnings}\n')
                if fails:
                    with self.assertRaisesRegex(RuntimeError, 'fixed MAC ' + pi4.Ethernet.MAC):
                        pi4.verify(vm)
                else:
                    pi4.verify(vm)

    def test_provisional_eui_follows_the_identity_helper(self):
        """FFFE between the two halves of the MAC, upper-cased, as osi-gateway-identity.sh derives it."""
        eui = pi4.provisional_eui(pi4.Ethernet.MAC)
        self.assertEqual((len(eui), eui[:6], eui[6:10], eui[10:]), (16, '525400', 'FFFE', '271104'))
        self.assertEqual(pi4.provisional_eui('b8-27-eb-12-34-56'), pi4.provisional_eui('B8:27:EB:12:34:56'))
        with self.assertRaisesRegex(ValueError, 'invalid MAC'):
            pi4.provisional_eui('52:54:00:27:11')

    def test_pi4_candidate_fails_for_missing_required_case(self):
        with tempfile.TemporaryDirectory() as directory:
            root = Path(directory)
            write_upgrade_fixtures(root, b'pi4 fixture')

            args = SimpleNamespace(fixtures=root, candidate=None, qemu=None, ram=2,
                                   osi_version='0.8.3', release_revision='a'*40,
                                   flows_power_cut_only=False, upgrade_boot_safety_only=False,
                                   customer_fixture_only=False, historical=True)

            def stock(_guest, _args, record, **_options):
                for label in acceptance.BASE_CASES[:-2]:
                    if label != 'Power cut 2':
                        record(label, lambda: None)

            with (redirect_stdout(io.StringIO()),
                  patch.object(acceptance, 'external_path', side_effect=lambda path, **_: path),
                  patch.object(acceptance, 'Guest') as guest,
                  patch.object(acceptance, 'checked', return_value=''),
                  patch.object(acceptance, 'stock_cases', side_effect=stock),
                  patch.object(acceptance, 'ready'), patch.object(acceptance, 'build_media'),
                  patch.object(acceptance, 'upgrade') as upgrade):
                self.assertEqual(acceptance.run_cases(args, root, root, root, 'unsupported', False, board='pi4'), 1)
            self.assertEqual(upgrade.call_count, 2)
            self.assertEqual([call.args[1].name for call in guest.call_args_list[1:]],
                             ['fixture-0.8.0.img.gz', 'fixture-0.8.1.img.gz'])
            result = (root/'results.log').read_text()
            self.assertIn('Power cut 2 | REQUIRED | NOT RUN | FAIL', result)
            self.assertRegex(result, re.escape('Upgrade 0.8.1') + r'\s+PASS')
            self.assertIn('Case totals: 9 passed / 10 required', result)
            self.assertIn('Historical diagnostics: FAIL', result)

    def test_api_wait_budget_is_the_slow_boot_budget(self):
        """A Pi 4 guest waits 900 s for the first /api/me answer: the budget #742 gave the 0.8.1 boot."""
        self.assertEqual(Pi4.API_WAIT_SECONDS, 900)
        self.assertEqual(Pi4.API_WAIT_SECONDS, SLOW_BOOT_SECONDS)
        self.assertEqual(Guest.API_WAIT_SECONDS, 420)
        with tempfile.TemporaryDirectory() as directory:
            vm = Pi4.__new__(Pi4)
            vm.receipts, vm.boots, vm.private = Path(directory), 3, False
            seen = []

            def command(script, timeout):
                # One poll per two seconds, and the host waits the whole budget.
                self.assertIn('seq 1 450', script)
                seen.append(timeout)
                return 0, ''

            vm.command = command
            upgrade_suite.wait_for_api(vm)
            self.assertEqual((vm.receipts/'harness-events.log').read_text(),
                             f'boot=3 {vm.waits[0]}\n')
            self.assertRegex(vm.waits[0], r'^api ready after \d+\.\d s \(budget 900 s\)$')
        self.assertEqual(seen, [900])

    def test_pi4_api_wait_still_polls_after_the_pi5_budget_is_spent(self):
        """The 0.8.4 re-take's Pi 4 restart needed more than the Pi 5's 210 polls."""
        for board, answer_at, answers in ((Pi4, 450, True), (Pi4, 451, False), (Guest, 300, False)):
            with self.subTest(board=board.__name__, answer_at=answer_at), tempfile.TemporaryDirectory() as directory:
                vm = board.__new__(board)
                vm.receipts, vm.boots, vm.private = Path(directory), 3, False
                vm.command = api_poll_answer(answer_at)
                if answers:
                    upgrade_suite.wait_for_api(vm)
                else:
                    with self.assertRaisesRegex(RuntimeError, 'guest command returned 1'):
                        upgrade_suite.wait_for_api(vm)
                outcome = 'ready' if answers else 'not ready'
                self.assertRegex(vm.waits[0], rf'^api {outcome} after \d+\.\d s \(budget {board.API_WAIT_SECONDS} s\)$')

    def test_wrapper_refuses_nested_slot(self):
        wrapper = Path(__file__).with_name('acceptance.sh')
        result = subprocess.run(['bash', wrapper], capture_output=True, text=True,
                                env={**os.environ, 'OSI_HEAVY_HOLDER': 'test:1', 'OSI_HEAVY': '/missing'})
        self.assertEqual(result.returncode, 2)
        self.assertIn('outside the current holder', result.stderr)


if __name__ == '__main__':
    unittest.main()
