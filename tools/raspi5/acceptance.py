"""OSI factory image acceptance tests. Invoke via acceptance.sh."""
import argparse
from contextlib import nullcontext
from dataclasses import dataclass, replace
from datetime import datetime, timezone
import hashlib
import os
import re
from pathlib import Path
import subprocess
import tempfile
import time

from archives import verified_archive
from minimal_flows import (
    CUT_RECEIPT, INIT, derive_probe_image, has_atomic_publish, prepare_probe_release, verify_disk,
)
from suite_vm import FLOWS_COMMITTED, Guest, external_path
from upgrade_suite import build_media, checked, run as upgrade, sql, wait_for_api
from boot_safety import TRANSFER_TARGETS, verify_zero_recovery, verify_missing_pristine_hold

HERE = Path(__file__).resolve().parent
UPGRADE_VERSIONS = ('0.8.0', '0.8.1')
BASE_CASES = ('Cold boot', 'First account and login', 'WM1302 uplinks',
              'Valve open and outcome', 'Reboot persistence',
              'Power cut 1', 'Power cut 2', 'Power cut 3',
              *(f'Upgrade {version}' for version in UPGRADE_VERSIONS))
ROM_INIT = '/rom/etc/init.d/node-red'
ROM_WRITER = '/rom/usr/share/node-red/osi-atomic-write.js'
ROM_FLOWS = '/rom/usr/share/flows.json'
FLOWS_CAPABILITY = 'function persistFlowHold('
FLOWS_CASES = ('Flows cut on first boot', 'Flows cut on later boot', 'Flows cut after upgrade')
ZERO_CASE = 'A. Zeroed upgraded flows preserve migration 0073'
PRISTINE_CASE = 'B. Missing pristine copy warns or holds'
TRANSFER_CASES = {key: f'C. Interrupted {key} install' for key in TRANSFER_TARGETS}
BOOT_SAFETY_CASES = (ZERO_CASE, PRISTINE_CASE, *TRANSFER_CASES.values())
RECOVERY_CASES = FLOWS_CASES + BOOT_SAFETY_CASES
MINIMAL_FACTORY_CASES = {
    'committed': 'Minimal factory cut after directory fsync',
    'before-dir-sync': 'Minimal factory cut before directory fsync',
}
MINIMAL_UPGRADE_CASE = 'Minimal flows cut on first post-upgrade start'
MINIMAL_CASES = (*MINIMAL_FACTORY_CASES.values(), MINIMAL_UPGRADE_CASE)
CUSTOMER_CASE = 'Customer-line 0.7.0 upgrade [PROVISIONAL]'


def has_flows_recovery(init_source):
    # Capability added by #714. Keep selection independent of the receipt
    # wording so a broken emitter fails the required cases.
    return any(line.startswith(FLOWS_CAPABILITY) for line in init_source.splitlines())


def flows_capability(init):
    if has_flows_recovery(init):
        return 'recovery'
    if has_atomic_publish(init):
        return 'minimal'
    return 'unsupported'


def read_image_capability(vm):
    return flows_capability(checked(vm, f'cat {ROM_INIT}'))


@dataclass(frozen=True)
class FactoryPayload:
    init: str
    writer: str
    flows: str

    def receipt(self):
        return f'init={self.init} writer={self.writer} flows={self.flows}'


def read_factory_payload(vm):
    paths = (ROM_INIT, ROM_WRITER, ROM_FLOWS)
    files = ' '.join(paths)
    output = checked(vm, f"""for file in {files}; do
test -f "$file" && test "$(readlink -f "$file")" = "$file" || exit 1
done
sha256sum {files}""")
    receipts = [line.split() for line in output.splitlines()]
    if len(receipts) != len(paths) or any(
        len(row) != 2 or row[1] != path or not re.fullmatch(r'[0-9a-f]{64}', row[0])
        for row, path in zip(receipts, paths)
    ):
        raise RuntimeError('invalid factory ROM payload digest receipt')
    return FactoryPayload(*(row[0] for row in receipts))


def tools_checkout_revision(expected):
    git = ['git', '-C', str(HERE)]
    root, revision = subprocess.check_output(
        git + ['rev-parse', '--show-toplevel', 'HEAD'], text=True).splitlines()
    if Path(root)/'tools/raspi5' != HERE or not re.fullmatch(r'[0-9a-f]{40}', revision):
        raise ValueError('emulator tools must run from their own Git checkout')
    if expected is not None:
        if revision != expected:
            raise ValueError('tools checkout HEAD differs from --tools-revision')
        changed = subprocess.check_output(
            git + ['status', '--porcelain', '--untracked-files=normal', '--', '.',
                   '../raspi4'], text=True)
        if changed:
            raise ValueError('emulator tools differ from the pinned checkout')
    return revision


@dataclass(frozen=True)
class NotApplicable:
    reason: str
    replacements: tuple[str, ...]


def expected_cases(args, image_capability, customer_selected, *, historical=False):
    if args.flows_power_cut_only:
        return dict.fromkeys(FLOWS_CASES)
    if args.upgrade_boot_safety_only:
        return dict.fromkeys(BOOT_SAFETY_CASES)
    if args.customer_fixture_only:
        return {CUSTOMER_CASE: None}
    cases = dict.fromkeys(BASE_CASES)
    if not historical:
        cases.update(dict.fromkeys(RECOVERY_CASES + MINIMAL_CASES))
        if image_capability == 'recovery':
            cases.update(dict.fromkeys(MINIMAL_CASES, NotApplicable(
                'persistFlowHold present in factory image init', RECOVERY_CASES)))
        elif image_capability == 'minimal':
            cases.update(dict.fromkeys(RECOVERY_CASES, NotApplicable(
                'persistFlowHold absent and minimal atomic publication present in factory image init', MINIMAL_CASES)))
    if customer_selected:
        cases[CUSTOMER_CASE] = None
    return cases


def ready(vm):
    checked(vm, """for i in $(seq 1 180); do
if test -s /data/db/farming.db && wget -q -T 2 -O /tmp/gui http://127.0.0.1:1880/gui/ && grep -qi '<html' /tmp/gui && pidof chirpstack >/dev/null && wget -q -T 2 -O /dev/null http://127.0.0.1:8080/; then
ip addr add 192.0.2.15/24 dev br-lan 2>/dev/null || ip -4 addr show | grep -q 192.0.2.15 || ip addr add 192.0.2.15/24 dev eth0
exit $?
fi
sleep 3
done
exit 1""", 800)
    if sql(vm,'PRAGMA integrity_check;') != 'ok':
        raise RuntimeError('integrity check failed')


def gui(vm, password, mode, *args):
    result=subprocess.run(['node', HERE/'gui-suite.cjs',mode,vm.url,*args],input=password+'\n',text=True,
                          stdout=subprocess.PIPE,stderr=subprocess.DEVNULL,timeout=140)
    if result.returncode:
        raise RuntimeError(f'GUI {mode} check failed')
    return result.stdout.strip()


def snapshot(vm):
    query = """SELECT username,role,password_hash FROM users ORDER BY id;
SELECT deveui,name,type_id FROM devices ORDER BY deveui;
SELECT id,deveui,recorded_at,bat_pct,ambient_temperature,swt_1,swt_2,swt_3 FROM device_data ORDER BY id;
SELECT deveui,recorded_at,soil_temp_c FROM watermark_readings ORDER BY id;
SELECT device_eui,command_id,commanded_duration_seconds FROM valve_actuation_expectations ORDER BY expectation_id;
SELECT key,value FROM app_settings WHERE key='emulator_persistence';"""
    return hashlib.sha256(sql(vm,query).encode()).hexdigest()


def cut(vm, n, *, inspect_disk=False):
    before = snapshot(vm)
    sql(vm, f"CREATE TABLE IF NOT EXISTS emulator_recovery(n INTEGER PRIMARY KEY); INSERT INTO emulator_recovery VALUES({n});")
    # The second transaction dirties more pages than the 8-page SQLite cache.
    # The shell marker executes inside the SQLite session before COMMIT.
    checked(vm, """rm -f /tmp/transaction-open
(sqlite3 /data/db/farming.db <<'SQL'
.bail on
.timeout 5000
PRAGMA cache_size=8;
BEGIN IMMEDIATE;
CREATE TABLE emulator_uncommitted(x BLOB);
INSERT INTO emulator_uncommitted VALUES(randomblob(1048576));
.shell touch /tmp/transaction-open
.shell sleep 90
COMMIT;
SQL
) </dev/null >/dev/null 2>&1 &
for i in $(seq 1 30); do test -f /tmp/transaction-open && exit 0; sleep 1; done; exit 1""")
    vm.stop(cut=True)

    def verify(guest, phase=''):
        prefix = f'{phase}: ' if phase else ''
        rows = sql(guest, "SELECT n FROM emulator_recovery ORDER BY n; SELECT count(*) FROM sqlite_master WHERE name='emulator_uncommitted';")
        if before != snapshot(guest):
            raise RuntimeError(prefix + 'gateway data changed across power loss')
        if rows.splitlines() != [str(i) for i in range(1,n+1)]+['0']:
            raise RuntimeError(prefix + 'committed or interrupted transaction mismatch')
        if phase:
            with (guest.receipts/'sqlite-cut.log').open('a') as log:
                print(f'cut {n} {phase} PASS', file=log)

    def inspect(guest):
        if sql(guest, 'PRAGMA integrity_check;') != 'ok':
            raise RuntimeError('disk before startup: SQLite integrity check failed')
        verify(guest, 'disk before startup')

    if inspect_disk:
        vm.inspect_cut(inspect)
    vm.start()
    ready(vm)
    verify(vm, 'after normal restart' if inspect_disk else '')


def cut_after_flows_patch(vm, first_boot):
    if first_boot:
        stamp = b'image'
        receipt = vm.start(before_console=FLOWS_COMMITTED)
    else:
        _, stamp = vm.flows_receipt()
        # Force an actual write on the next boot. UCI settings or identity
        # resolution may restore a UCI change, so change the fixture client ID.
        checked(vm, """node - <<'JS'
const fs = require('fs');
const filename = '/srv/node-red/flows.json';
const flows = JSON.parse(fs.readFileSync(filename, 'utf8'));
const broker = flows.find(node => node.type === 'mqtt-broker' && node.name === 'OSI Cloud Broker');
if (!broker || !/^device_[0-9A-F]{16}$/.test(broker.clientid)) process.exit(1);
broker.clientid = 'device_emulator_stale';
fs.writeFileSync(filename, JSON.stringify(flows));
JS""")
        receipt = vm.upgrade_reboot('sync && reboot', before_console=FLOWS_COMMITTED)

    # The init sends the marker just after publication and before procd
    # starts Node-RED. Kill QEMU immediately, without a guest command.
    vm.stop(cut=True)
    if receipt[1] != stamp:
        raise RuntimeError('boot commit named an unexpected payload stamp')
    vm.verify_cut_disk('factory' if first_boot else 'later boot', receipt)
    vm.start()
    wait_for_api(vm)
    ready(vm)
    vm.verify_flows_receipt(receipt)
    checked(vm, """node - <<'JS'
const fs = require('fs');
const flows = JSON.parse(fs.readFileSync('/srv/node-red/flows.json', 'utf8'));
const broker = flows.find(node => node.type === 'mqtt-broker' && node.name === 'OSI Cloud Broker');
if (!broker || !/^device_[0-9A-F]{16}$/.test(broker.clientid)) process.exit(1);
JS""")
    return 'hard cut at flows commit; recovered digest, stamp and API verified'


def main(argv=None, *, board='pi5', guest_class=None, memory=(4, 8), verify_board=None):
    ap=argparse.ArgumentParser()
    ap.add_argument('--candidate', type=Path)
    ap.add_argument('--candidate-sha256')
    ap.add_argument('--tools-revision', help='pinned Git commit of the emulator tools checkout')
    ap.add_argument('--openwrt-host-tools', type=Path,
                    help='OpenWrt staging_dir/host used to derive the minimal factory probe')
    ap.add_argument('--osi-version', required=True)
    ap.add_argument('--chirpstack-version', required=True)
    ap.add_argument('--release', type=Path, required=True,
                    help='offline deployment tree used for the upgrades')
    ap.add_argument('--release-revision', required=True,
                    help='full Git SHA in the offline release tree receipt')
    ap.add_argument('--fixtures', type=Path, required=True)
    ap.add_argument('--qemu',type=Path,default=Path.home()/f'.cache/osi-os/ras{board}/qemu-system-aarch64')
    ap.add_argument('--run-root',type=Path,required=True)
    ap.add_argument('--ram',type=int,choices=memory,default=memory[-1])
    ap.add_argument('--keep-scratch', action='store_true',
                    help='retain writable guest disks and USB copies in the owner-only run directory')
    mode = ap.add_mutually_exclusive_group()
    mode.add_argument('--flows-power-cut-only', action='store_true',
                    help='rerun only the three flows cut cases on a candidate containing PR #714')
    mode.add_argument('--upgrade-boot-safety-only', action='store_true',
                      help='rerun cases A, B and C using the offline release and 0.8.1 fixture')
    ap.set_defaults(customer_fixture_only=False, historical=False)
    if board == 'pi5':
        mode.add_argument('--customer-fixture-only', action='store_true',
                          help='rerun only the opt-in customer-line 0.7.0 fixture')
    else:
        mode.add_argument('--historical', action='store_true',
                          help='run ten baseline diagnostics on an image preceding both flows fixes')
    args=ap.parse_args(argv)
    if not re.fullmatch(r'[0-9a-f]{40}', args.release_revision):
        ap.error('--release-revision must be a full commit SHA')
    if not args.upgrade_boot_safety_only or args.candidate or args.candidate_sha256:
        if args.candidate is None or not re.fullmatch(r'[0-9a-f]{64}', args.candidate_sha256 or ''):
            ap.error('--candidate and a lowercase --candidate-sha256 are required together')
    if board == 'pi4':
        try:
            args.run_root = external_path(args.run_root, off_tmp=True)
            args.release = external_path(args.release, off_tmp=True)
            args.fixtures = external_path(args.fixtures, off_tmp=True)
            if args.candidate is not None:
                args.candidate = external_path(args.candidate, off_tmp=True)
        except (OSError, ValueError, RuntimeError):
            ap.error('run root and Pi 4 inputs must exist outside Git trees and /tmp')
    release = args.release.resolve()
    receipt = (release/'SERVED-FROM.txt').read_text()
    if not re.search(rf'\b{args.release_revision}\b', receipt):
        ap.error('offline release receipt does not identify --release-revision')
    capability = flows_capability((release/INIT).read_text())
    if (args.flows_power_cut_only or args.upgrade_boot_safety_only) and capability != 'recovery':
        ap.error('focused boot cases require an offline release with the flows fix from PR #714')
    customer_image = os.environ.get('OSI_RASPI5_CUSTOMER_IMAGE') if board == 'pi5' else None
    customer_source = os.environ.get('OSI_RASPI5_CUSTOMER_FIXTURE_DIR') if board == 'pi5' else None
    if bool(customer_image) != bool(customer_source):
        ap.error('set both OSI_RASPI5_CUSTOMER_IMAGE and OSI_RASPI5_CUSTOMER_FIXTURE_DIR')
    if args.customer_fixture_only and not customer_image:
        ap.error('--customer-fixture-only requires both private fixture variables')
    try:
        args.run_root = external_path(args.run_root)
        if customer_image:
            args.customer_image = external_path(Path(customer_image))
            args.customer_source = external_path(Path(customer_source))
    except (OSError, ValueError, RuntimeError):
        ap.error('run root and private inputs must resolve to existing paths outside any Git tree')
    try:
        tools_revision = tools_checkout_revision(args.tools_revision)
    except (OSError, subprocess.CalledProcessError, ValueError) as error:
        ap.error(f'cannot verify tools checkout revision: {error}')
    os.umask(0o077)
    run=Path(tempfile.mkdtemp(prefix=f'{board}-acceptance-',dir=args.run_root))
    print(run,flush=True)
    (run/'results.log').write_text(
        f'Candidate revision: {args.release_revision}\nTools revision: {tools_revision}\n')
    (run/'inputs.txt').write_text(
        f'started_utc={datetime.now(timezone.utc).isoformat()}\nboard={board}\n'
        f'historical={args.historical}\n'
        f'revision={args.release_revision}\ntools_revision={tools_revision}\n'
        f'candidate_sha256={args.candidate_sha256}\n'
        f'osi_version={args.osi_version}\nchirpstack_version={args.chirpstack_version}\n'
        f'offline_flows_capability={capability}\n'
        f'flows_power_cut_only={args.flows_power_cut_only}\n'
        f'upgrade_boot_safety_only={args.upgrade_boot_safety_only}\n'
        f'customer_fixture_only={args.customer_fixture_only}\n')
    if args.keep_scratch:
        scratch = run/'scratch'
        scratch.mkdir(mode=0o700)
        scratch_dir = nullcontext(scratch)
    else:
        scratch_dir = tempfile.TemporaryDirectory(prefix='scratch-', dir=run)
    with scratch_dir as directory:
        scratch = Path(directory)
        env = {key: os.environ.get(key) for key in ('TMPDIR', 'TMP', 'TEMP')} if board == 'pi4' else {}
        try:
            os.environ.update(dict.fromkeys(env, str(scratch)))
            return run_cases(args, run, scratch, release, capability, bool(customer_image),
                             board=board, guest_class=guest_class, verify_board=verify_board)
        finally:
            for key, value in env.items():
                if value is None:
                    os.environ.pop(key, None)
                else:
                    os.environ[key] = value
            (run/'stopped.utc').write_text(datetime.now(timezone.utc).isoformat() + '\n')


def run_cases(args, run, scratch, release, release_capability, customer_selected, *,
              board='pi5', guest_class=None, verify_board=None):
    make_guest = guest_class if guest_class is not None else Guest
    results = {}

    def record(row):
        with (run/'results.log').open('a') as log:
            print(row, file=log)
        print(row, flush=True)

    focused = args.flows_power_cut_only or args.customer_fixture_only or args.upgrade_boot_safety_only
    historical = board == 'pi4' and args.historical
    expected = expected_cases(args, None, customer_selected, historical=historical)

    def summarize(*, aborted=False):
        record('Case | Expected | Observed | Verdict | Reason | Required replacements')
        passed = required = 0
        failed = aborted or bool(results.keys() - expected.keys())
        for label, exemption in expected.items():
            observed = results.get(label, 'NOT RUN')
            if exemption is None:
                required += 1
                passed += observed == 'PASS'
                verdict = 'PASS' if observed == 'PASS' else 'FAIL'
                need, reason, replacements = 'REQUIRED', '', ''
            else:
                verdict = 'N/A' if observed == 'NOT RUN' else 'FAIL'
                need, reason = 'N/A', exemption.reason
                replacements = ', '.join(exemption.replacements)
                failed |= any(
                    replacement not in expected or expected[replacement] is not None
                    or results.get(replacement) != 'PASS'
                    for replacement in exemption.replacements
                )
            failed |= verdict == 'FAIL'
            record(f'{label} | {need} | {observed} | {verdict} | {reason} | {replacements}')
        record(f'Case totals: {passed} passed / {required} required')
        mode = ('Historical diagnostics' if historical else
                'Focused acceptance' if focused else 'Candidate acceptance')
        record(f'{mode}: ' + ('FAIL' if failed else 'PASS'))
        return int(failed)

    def test(label, fn, *, private=False):
        start=time.monotonic()
        try:
            detail=fn()
            status='PASS'
        except Exception as e:
            if private:
                from customer_fixture import FixtureFailure
                detail = str(e) if isinstance(e, FixtureFailure) else 'private case failed; see phase receipts'
            else:
                detail = str(e)
            status='FAIL'
        row=f'{label:26} {status} {time.monotonic()-start:7.1f}s  {detail or ""}'
        results[label] = status
        record(row)

    media=None
    fixture_archives = {}

    def candidate_media():
        nonlocal media
        if media is None:
            media = build_media(release, scratch, revision=args.release_revision)
        return media

    def fixture_archive(old):
        if old not in fixture_archives:
            folder = args.fixtures/f'v{old}'
            if board == 'pi4':
                folder = external_path(folder, off_tmp=True)
            images = sorted(folder.glob(f'*r{board}*.img.gz'))
            if len(images) != 1:
                raise ValueError(f'expected one {board} fixture archive for {old}')
            image = images[0]
            sums = folder/'SHA256SUMS'
            if board == 'pi4':
                external_path(image, off_tmp=True)
                sums = external_path(sums, off_tmp=True)
            entries = [line.split(maxsplit=1) for line in sums.read_text().splitlines()]
            matches = [entry[0] for entry in entries if len(entry) == 2 and entry[1].lstrip('*') == image.name]
            if len(matches) != 1 or not re.fullmatch(r'[0-9a-f]{64}', matches[0]):
                raise ValueError('fixture checksum manifest must identify exactly one archive digest')
            fixture_archives[old] = verified_archive(
                image, matches[0], scratch/f'fixture-{old}.img.gz', label='fixture archive')
            if board == 'pi4':
                with (run/'fixtures.log').open('a') as log:
                    print(old, matches[0], file=log)
        return fixture_archives[old]

    def verify_upgrade(old, *, cut_at=None, recovery=None, transfer=None):
        image = fixture_archive(old)
        minimal = cut_at == CUT_RECEIPT
        scenario = transfer or recovery or ('minimal-cut' if minimal else 'flows-cut' if cut_at else None)
        upgrade_media = build_media(probe_release, scratch/'minimal-media',
                                    revision=args.release_revision) if minimal else candidate_media()
        case = f'{old}-{scenario}' if scenario else old
        guest = make_guest(scratch/case, image, args.qemu, args.ram, upgrade=upgrade_media,
                      receipts=run/case, direct_io=bool(scenario))
        try:
            if minimal:
                guest.start(flow_cut='committed')
            else:
                guest.start()
            ready(guest)
            previous = upgrade(guest, old, args.osi_version, cut_at=cut_at, transfer=transfer,
                               release=probe_release if minimal else release)
            if recovery == 'zero':
                verify_zero_recovery(guest, release, previous)
                return 'pristine recovery preserved trigger definitions, fixture and API'
            if recovery == 'missing':
                verify_missing_pristine_hold(guest)
                return 'healthy flows warned and served; zeroed flows held for redeploy'
            if transfer:
                return 'disk retained complete boot files and previous payload'
            return 'recovered candidate digest, stamp, API and fixture verified' if cut_at else None
        finally:
            guest.stop()

    def factory_minimal_cut(phase):
        case = scratch/f'minimal-factory-{phase}'
        vm = make_guest(case, probe_image, args.qemu, args.ram, receipts=run/case.name, direct_io=True)
        try:
            receipt = vm.start(before_console=CUT_RECEIPT, flow_cut=phase)
            committed = verify_disk(vm, receipt, phase=phase, factory=True,
                                    shipped_old=candidate_payload.flows.encode(),
                                    shipped_init=probe_init_digest.encode(),
                                    shipped_writer=candidate_payload.writer.encode())
            vm.start()
            observed = read_factory_payload(vm)
            record(f'Factory probe ROM ({phase}): {observed.receipt()}')
            expected_probe = replace(candidate_payload, init=probe_init_digest)
            if observed != expected_probe:
                raise RuntimeError('factory probe ROM init, writer or starting flows differs from the candidate binding')
            wait_for_api(vm)
            vm.verify_flows_receipt(committed)
            return 'clone held complete old or new flows and /api/me returned 401'
        finally:
            vm.stop()

    image_capability = None
    try:
        candidate = None
        if getattr(args, 'candidate', None) is not None:
            try:
                candidate = verified_archive(args.candidate, args.candidate_sha256,
                                             scratch/'verified-candidate.img', label='candidate archive')
            except (OSError, ValueError) as error:
                record(str(error))
                return summarize(aborted=True)
        if not focused:
            vm = make_guest(scratch/'candidate', candidate, args.qemu, args.ram,
                       receipts=run/'candidate', direct_io=True)
            try:
                try:
                    vm.start()
                    image_capability = read_image_capability(vm)
                except Exception as error:
                    record(f'Factory image capability probe failed: {error}')
                    return summarize(aborted=True)
                record(f'Factory image flows capability: {image_capability}')
                expected = expected_cases(args, image_capability, customer_selected, historical=historical)
                if image_capability != release_capability:
                    record('Factory image and offline tree disagree on flows publication capability')
                    return summarize(aborted=True)
                if historical and image_capability != 'unsupported':
                    record('Historical diagnostics require an image preceding both flows fixes')
                    return summarize(aborted=True)
                if not historical and image_capability == 'unsupported':
                    record('Factory image declares neither #714 recovery nor minimal atomic flows publication')
                    return summarize(aborted=True)
                if image_capability == 'minimal':
                    try:
                        candidate_payload = read_factory_payload(vm)
                        record(f'Candidate factory ROM: {candidate_payload.receipt()}')
                        if candidate_payload.init != hashlib.sha256((release/INIT).read_bytes()).hexdigest():
                            raise ValueError('candidate factory ROM init differs from the offline source')
                        if args.openwrt_host_tools is None:
                            raise ValueError('minimal qualification requires --openwrt-host-tools')
                        host_tools = args.openwrt_host_tools.resolve(strict=True)
                        probe_release = scratch/'probe-release'
                        probe_init_digest = prepare_probe_release(release, probe_release)
                        probe_image = scratch/'derived-probe.img'
                        probe_sha256 = derive_probe_image(candidate, release, probe_release,
                                                          probe_image, host_tools)
                        record(f'Derived probe SHA-256: {probe_sha256} from candidate {args.candidate_sha256}')
                        (scratch/'minimal-media').mkdir()
                    except (OSError, ValueError, RuntimeError, subprocess.CalledProcessError) as error:
                        record(str(error))
                        return summarize(aborted=True)
                stock_cases(vm, args, test, log=record, verify_board=verify_board, inspect_disk=board == 'pi4')
            finally:
                vm.stop()
            for old in UPGRADE_VERSIONS:
                test(f'Upgrade {old}', lambda: verify_upgrade(old))
        if expected.get(FLOWS_CASES[0], False) is None:
            for first_boot, label in zip((True, False), FLOWS_CASES[:2]):
                def check_cut():
                    case = label.replace(' ', '-')
                    vm = make_guest(scratch/case, candidate, args.qemu, args.ram,
                               receipts=run/case, direct_io=True)
                    try:
                        if not first_boot:
                            vm.start()
                            ready(vm)
                        return cut_after_flows_patch(vm, first_boot)
                    finally:
                        vm.stop()

                test(label, check_cut)
            test(FLOWS_CASES[2], lambda: verify_upgrade('0.8.1', cut_at=FLOWS_COMMITTED))
        if expected.get(ZERO_CASE, False) is None:
            test(ZERO_CASE, lambda: verify_upgrade('0.8.1', cut_at=FLOWS_COMMITTED, recovery='zero'))
            test(PRISTINE_CASE, lambda: verify_upgrade('0.8.1', recovery='missing'))
            for transfer, label in TRANSFER_CASES.items():
                test(label, lambda: verify_upgrade('0.8.1', transfer=transfer))
        if image_capability == 'minimal':
            for phase, label in MINIMAL_FACTORY_CASES.items():
                test(label, lambda: factory_minimal_cut(phase))
            test(MINIMAL_UPGRADE_CASE, lambda: verify_upgrade('0.8.1', cut_at=CUT_RECEIPT))
        if board == 'pi5' and (not focused or args.customer_fixture_only):
            from customer_fixture import QUALIFICATION_SCOPE, run as customer_upgrade
            selection = 'opt-in qualification' if customer_selected else 'off by default'
            record(f'{CUSTOMER_CASE}: {selection}. Count this fixture as release evidence only with a '
                   f'successful owner-only qualification receipt for the exact pair. {QUALIFICATION_SCOPE}')
            if customer_selected:
                test(CUSTOMER_CASE, lambda: customer_upgrade(args, scratch, run, release, ready), private=True)
    except BaseException:
        summarize(aborted=True)
        raise
    return summarize()


def stock_cases(vm, args, test, *, log=print, verify_board=None, inspect_disk=False):
    from radio_suite import Radio, VALVE, radio_diagnostics, run_uplinks, run_valve

    def boot():
        ready(vm)
        if verify_board is not None:
            verify_board(vm)
        versions=checked(vm,'uci get osi-server.cloud.firmware_version; chirpstack --version')
        if versions.splitlines()!=[args.osi_version, f'chirpstack {args.chirpstack_version}']:
            raise RuntimeError('unexpected versions '+versions)
        return f'OSI {args.osi_version}, ChirpStack {args.chirpstack_version}, /gui/ served, integrity ok'
    test('Cold boot',boot)
    password=None
    def account():
        nonlocal password
        password=checked(vm,"head -c 24 /dev/urandom | hexdump -v -e '1/1 \"%02x\"'")
        checked(vm,"""for i in $(seq 1 100); do [ \"$(curl -s -o /dev/null -w '%{http_code}' http://127.0.0.1:1880/api/me)\" = 401 ] && exit 0; sleep 2; done; exit 1""")
        if sql(vm,'SELECT count(*) FROM users;')!='0':
            raise RuntimeError('factory accounts already present')
        observed=gui(vm,password,'setup')
        role=sql(vm,"SELECT role FROM users WHERE username='emulator-admin';")
        if role!='researcher':
            raise RuntimeError('unexpected stored role')
        return 'stored '+role+'; '+observed
    test('First account and login',account)
    air = Radio(vm.radio)
    session={}
    def uplinks():
        try:
            joined, evidence = run_uplinks(vm, air, password, log=log)
            session.update(joined)
            return evidence
        except Exception:
            radio_diagnostics(vm)
            raise
    test('WM1302 uplinks',uplinks)
    def valve():
        evidence = run_valve(vm,air,session,lambda: gui(vm,password,'open',VALVE))
        gui(vm,password,'outcome',VALVE)
        return evidence
    test('Valve open and outcome',valve)
    def reboot():
        sql(vm,"INSERT OR REPLACE INTO app_settings(key,value) VALUES('emulator_persistence','retain');")
        before=snapshot(vm)
        vm.reboot()
        ready(vm)
        if before!=snapshot(vm): raise RuntimeError('persistent state changed')
        return 'account/device/history snapshot and setting preserved'
    test('Reboot persistence',reboot)
    for n in range(1,4):
        test(f'Power cut {n}', lambda: cut(vm, n, inspect_disk=inspect_disk))


if __name__=='__main__':
    raise SystemExit(main())
