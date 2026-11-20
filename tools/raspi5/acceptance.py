"""OSI factory image acceptance tests. Invoke via acceptance.sh."""
import argparse
import hashlib
import os
import re
from pathlib import Path
import subprocess
import tempfile
import time

from suite_vm import Guest
from upgrade_suite import build_media, checked, run as upgrade, sql

HERE = Path(__file__).resolve().parent
FLOWS_MARKER = 'node-red.init: committed flows.json MQTT runtime settings'
FLOWS_COMMITTED = re.escape(FLOWS_MARKER.encode()) + rb'\r?\n'


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


def cut(vm,n):
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
    vm.start()
    ready(vm)
    rows = sql(vm, "SELECT n FROM emulator_recovery ORDER BY n; SELECT count(*) FROM sqlite_master WHERE name='emulator_uncommitted';")
    if before != snapshot(vm):
        raise RuntimeError('gateway data changed across power loss')
    if rows.splitlines() != [str(i) for i in range(1,n+1)]+['0']:
        raise RuntimeError('committed or interrupted transaction mismatch')


def assert_flows_api(vm):
    checked(vm, """for i in $(seq 1 100); do
    code=$(curl -s --max-time 2 -o /dev/null -w '%{http_code}' http://127.0.0.1:1880/api/me)
    [ "$code" = 401 ] && exit 0
    sleep 2
done
exit 1""", 420)


def cut_after_flows_patch(vm, first_boot):
    if first_boot:
        vm.start(before_console=FLOWS_COMMITTED)
    else:
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
        vm.upgrade_reboot('sync && reboot', before_console=FLOWS_COMMITTED)

    # The init sends the marker just after publication and before procd
    # starts Node-RED. Kill QEMU immediately, without a guest command.
    vm.stop(cut=True)
    vm.start()
    assert_flows_api(vm)
    ready(vm)
    checked(vm, """node - <<'JS'
const fs = require('fs');
const flows = JSON.parse(fs.readFileSync('/srv/node-red/flows.json', 'utf8'));
const broker = flows.find(node => node.type === 'mqtt-broker' && node.name === 'OSI Cloud Broker');
if (!broker || !/^device_[0-9A-F]{16}$/.test(broker.clientid)) process.exit(1);
JS""")
    return 'hard cut at flows commit; /api/me returned 401 after restart'


def main():
    ap=argparse.ArgumentParser()
    ap.add_argument('--candidate', type=Path, required=True)
    ap.add_argument('--candidate-sha256', required=True)
    ap.add_argument('--osi-version', required=True)
    ap.add_argument('--chirpstack-version', required=True)
    ap.add_argument('--release', type=Path, required=True,
                    help='offline deployment tree used for the upgrades')
    ap.add_argument('--release-revision', required=True,
                    help='full Git SHA in the offline release tree receipt')
    ap.add_argument('--fixtures', type=Path, required=True)
    ap.add_argument('--qemu',type=Path,default=Path.home()/'.cache/osi-os/raspi5/qemu-system-aarch64')
    ap.add_argument('--run-root',type=Path,required=True)
    ap.add_argument('--ram',type=int,choices=(4,8),default=8)
    ap.add_argument('--flows-power-cut-only', action='store_true',
                    help='rerun only the three flows cut cases on a candidate containing PR #714')
    args=ap.parse_args()
    if not re.fullmatch(r'[0-9a-f]{40}', args.release_revision):
        ap.error('--release-revision must be a full commit SHA')
    if not re.fullmatch(r'[0-9a-f]{64}', args.candidate_sha256):
        ap.error('--candidate-sha256 must be a lowercase SHA-256')
    release = args.release.resolve()
    receipt = (release/'SERVED-FROM.txt').read_text()
    if not re.search(rf'\b{args.release_revision}\b', receipt):
        ap.error('offline release receipt does not identify --release-revision')
    init = release/'feeds/chirpstack-openwrt-feed/apps/node-red/files/node-red.init'
    flows_cuts = FLOWS_MARKER in init.read_text()
    if args.flows_power_cut_only and not flows_cuts:
        ap.error('--flows-power-cut-only requires a candidate built with the flows fix from PR #714')
    customer_image = os.environ.get('OSI_RASPI5_CUSTOMER_IMAGE')
    customer_source = os.environ.get('OSI_RASPI5_CUSTOMER_FIXTURE_DIR')
    if bool(customer_image) != bool(customer_source):
        ap.error('set both OSI_RASPI5_CUSTOMER_IMAGE and OSI_RASPI5_CUSTOMER_FIXTURE_DIR')
    with args.candidate.open('rb') as stream:
        if hashlib.file_digest(stream, 'sha256').hexdigest() != args.candidate_sha256:
            ap.error('candidate SHA-256 mismatch')
    os.umask(0o077)
    run=Path(tempfile.mkdtemp(prefix='pi5-acceptance-',dir=args.run_root))
    print(run,flush=True)
    (run/'inputs.txt').write_text(
        f'revision={args.release_revision}\ncandidate_sha256={args.candidate_sha256}\n'
        f'osi_version={args.osi_version}\nchirpstack_version={args.chirpstack_version}\n'
        f'flows_power_cut_only={args.flows_power_cut_only}\n')
    results=[]

    def record(row):
        with (run/'results.log').open('a') as log:
            print(row, file=log)
        print(row, flush=True)

    def test(label,fn):
        start=time.monotonic()
        try:
            detail=fn()
            status='PASS'
        except Exception as e:
            detail=str(e)
            status='FAIL'
        row=f'{label:26} {status} {time.monotonic()-start:7.1f}s  {detail or ""}'
        results.append((status,row))
        record(row)

    media=None

    def candidate_media():
        nonlocal media
        if media is None:
            media = build_media(release, run, revision=args.release_revision)
        return media

    def verify_upgrade(old, cut_at=None):
        folder = args.fixtures/f'v{old}'
        images = sorted(folder.glob('*rpi5*.img.gz'))
        if len(images) != 1:
            raise ValueError(f'expected one Pi 5 fixture archive for {old}')
        image = images[0]
        with image.open('rb') as stream:
            digest = hashlib.file_digest(stream, 'sha256').hexdigest()
        if [digest, image.name] not in [line.split() for line in (folder/'SHA256SUMS').read_text().splitlines()]:
            raise ValueError('fixture SHA-256 mismatch')
        case = f'{old}-flows-cut' if cut_at else old
        guest = Guest(run/case, image, args.qemu, args.ram, upgrade=candidate_media())
        try:
            guest.start()
            ready(guest)
            upgrade(guest, old, args.osi_version, cut_at=cut_at)
            return 'hard cut at first post-upgrade flows commit; API and fixture survived' if cut_at else None
        finally:
            guest.stop()

    if not args.flows_power_cut_only:
        vm = Guest(run/'candidate', args.candidate, args.qemu, args.ram)
        stock_cases(vm, args, test)
        for old in ['0.8.0', '0.8.1']:
            test(f'Upgrade {old}', lambda: verify_upgrade(old))
    if flows_cuts:
        for first_boot, label in [(True, 'Flows cut on first boot'), (False, 'Flows cut on later boot')]:
            def check_cut():
                vm = Guest(run/label.replace(' ', '-'), args.candidate, args.qemu, args.ram)
                try:
                    if not first_boot:
                        vm.start()
                        ready(vm)
                    return cut_after_flows_patch(vm, first_boot)
                finally:
                    vm.stop()

            test(label, check_cut)
        test('Flows cut after upgrade', lambda: verify_upgrade('0.8.1', FLOWS_COMMITTED))
    else:
        record('Flows power cuts pending (requires PR #714 in candidate source)')
    if not args.flows_power_cut_only:
        if customer_image:
            from customer_fixture import run as customer_upgrade
            test('Customer-line 0.7.0 upgrade', lambda: customer_upgrade(args, run, release, ready))
        else:
            record('Customer-line 0.7.0 upgrade pending (private inputs not supplied)')
    failed = any(status == 'FAIL' for status, _ in results)
    print('\nCheck                      Result  Elapsed')
    for _,row in results: print(row)
    record('Selected acceptance cases: ' + ('FAIL' if failed else 'PASS'))
    return int(failed)


def stock_cases(vm, args, test):
    try:
        def boot():
            vm.start()
            ready(vm)
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
        session={}
        def uplinks():
            from radio_suite import run_uplinks
            try:
                session.update(run_uplinks(vm,password))
            except Exception:
                # Report only fixed labels and counts. Application logs can contain credentials.
                _, diag=vm.command('''for needle in "JoinRequest" "join-request" "invalid MIC" "InvalidMIC" "unknown device" "region mismatch" "device-profile" "uplink frame" "downlink frame" "Too late" "TX_ACK" "CRC_OK"; do
printf '%s ' "$needle"; logread | grep -Fi -c "$needle"; done
for svc in chirpstack chirpstack-mqtt-forwarder chirpstack-concentratord-sx1302; do pidof "$svc" >/dev/null && echo "$svc running"; done''')
                (vm.work/'radio-diagnostics.log').write_text(diag+'\n')
                raise
        test('WM1302 uplinks',uplinks)
        def valve():
            from radio_suite import run_valve, VALVE
            run_valve(vm,password,session,lambda: gui(vm,password,'open',VALVE))
            gui(vm,password,'outcome',VALVE)
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
            test(f'Power cut {n}',lambda: cut(vm,n))
    finally: vm.stop()


if __name__=='__main__':
    raise SystemExit(main())
