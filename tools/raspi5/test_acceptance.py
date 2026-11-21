"""Host-only tests for the Pi 5 acceptance runner."""
from contextlib import redirect_stderr, redirect_stdout
import hashlib
import io
import json
import os
from pathlib import Path
import re
import subprocess
import tarfile
import tempfile
from types import SimpleNamespace
import unittest
from unittest.mock import Mock, patch

import acceptance
import boot_safety
import customer_fixture
import run
from suite_vm import FLOWS_COMMITTED, Guest, external_path
import upgrade_suite


# PR #714 at 453207679276be8ef75fa64f6be85c2c6636585a.
PINNED_CAPABILITY = 'function persistFlowHold(stamp, reason) {'
DIGEST = b'a' * 64
COMMIT = b'node-red.init: committed flows.json digest=' + DIGEST + b' stamp=20261120T000000Z\r\n'


class FlowTests(unittest.TestCase):
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

    def test_factory_image_and_offline_tree_must_agree(self):
        with patch.object(acceptance, 'checked', return_value=PINNED_CAPABILITY):
            with self.assertRaisesRegex(RuntimeError, 'disagree on flows recovery'):
                acceptance.check_image_capability(None, False)
            acceptance.check_image_capability(None, True)

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
            vm.process = vm.bridge = None
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
            with (patch('suite_vm.subprocess.Popen') as launch,
                  patch.object(vm, 'expect', return_value=report),
                  patch.object(vm, 'send')):
                vm.start(inspection=True)
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
                                   release_revision='a'*40, osi_version='0.8.3',
                                   flows_power_cut_only=True, customer_fixture_only=False,
                                   upgrade_boot_safety_only=False)
            with (redirect_stdout(io.StringIO()), patch.object(acceptance, 'Guest'),
                  patch.object(acceptance, 'build_media'), patch.object(acceptance, 'ready'),
                  patch.object(acceptance, 'cut_after_flows_patch', side_effect=TimeoutError('missing receipt')),
                  patch.object(acceptance, 'upgrade', side_effect=RuntimeError('missing receipt'))):
                self.assertEqual(acceptance.run_cases(args, root, root, root, True, False), 1)
            result = (root/'results.log').read_text()
            for label in acceptance.FLOWS_CASES:
                self.assertRegex(result, re.escape(label) + r'\s+FAIL')
            self.assertIn('Focused acceptance: FAIL', result)

    def test_old_candidate_reports_each_cut_as_not_applicable(self):
        with tempfile.TemporaryDirectory() as directory:
            root = Path(directory)
            args = SimpleNamespace(candidate=None, qemu=None, ram=8, fixtures=root,
                                   flows_power_cut_only=False, customer_fixture_only=False,
                                   upgrade_boot_safety_only=False,
                                   release_revision='a'*40, osi_version='0.8.3')
            for version in ('0.8.0', '0.8.1'):
                folder = root/f'v{version}'
                folder.mkdir()
                (folder/'rpi5.img.gz').write_bytes(b'fixture')
                (folder/'SHA256SUMS').write_text(hashlib.sha256(b'fixture').hexdigest() + '  rpi5.img.gz\n')
            with (redirect_stdout(io.StringIO()), patch.object(acceptance, 'Guest'),
                  patch.object(acceptance, 'stock_cases'), patch.object(acceptance, 'ready'),
                  patch.object(acceptance, 'build_media'), patch.object(acceptance, 'upgrade')):
                self.assertEqual(acceptance.run_cases(args, root, root, root, False, False), 0)
            result = (root/'results.log').read_text()
            for label in acceptance.FLOWS_CASES:
                self.assertIn(f'{label}: not applicable to this candidate', result)

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
                self.assertEqual(acceptance.run_cases(args, root, root, root, True, False), 1)
            self.assertEqual(deploy.call_count, 5)
            self.assertTrue(all(call.kwargs['direct_io'] for call in guest.call_args_list))
            zero.assert_called_once()
            hold.assert_called_once()
            result = (root/'results.log').read_text()
            self.assertRegex(result, r'C\. Interrupted init install\s+FAIL')
            self.assertIn('Focused acceptance: FAIL', result)

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
                self.assertEqual(acceptance.run_cases(args, root, root, root, False, True), 1)
            self.assertNotIn('private-filename', stdout.getvalue() + (root/'results.log').read_text())
            self.assertIn('private case failed', stdout.getvalue())

    def test_both_processes_are_reaped_even_when_exit_receipt_fails(self):
        with tempfile.TemporaryDirectory() as directory:
            vm = Guest.__new__(Guest)
            guest, bridge = Mock(), Mock()
            vm.process, vm.bridge = guest, bridge
            vm.boots = 1
            vm.receipts = Path(directory)/'missing'
            guest.poll.return_value = bridge.poll.return_value = None
            guest.wait.side_effect = bridge.wait.side_effect = [subprocess.TimeoutExpired('qemu', 5), -9]
            with self.assertRaises(ExceptionGroup):
                vm.stop()
            for process in (guest, bridge):
                process.terminate.assert_called_once()
                process.kill.assert_called_once()
                self.assertEqual(process.wait.call_count, 2)
            self.assertIsNone(vm.process)
            self.assertIsNone(vm.bridge)

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
            files, identity = customer_fixture.verified_inputs(image, root, root)
            self.assertNotIn(customer_fixture.PROVENANCE, files)
            self.assertEqual(identity['legacy_archive_migration_sha256'], digest)
            manifest.write_text(json.dumps({candidate: 'a'*64}))
            with self.assertRaisesRegex(ValueError, 'does not match candidate migration 0080'):
                customer_fixture.verified_inputs(image, root, root)


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
