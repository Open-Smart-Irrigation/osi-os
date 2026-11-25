"""Upgrade a disposable old guest through the shipped offline installer."""
import base64
import hashlib
import json
import tarfile
import os
import subprocess
import time
from pathlib import Path

import boot_timing
from minimal_flows import CUT_RECEIPT, INIT, verify_disk
from suite_vm import timed

DB = '/data/db/farming.db'
SEED = """
INSERT INTO devices(deveui,name,type_id,created_at,updated_at) VALUES('A840410000000001','upgrade fixture','DRAGINO_LSN50',CURRENT_TIMESTAMP,CURRENT_TIMESTAMP);
INSERT INTO device_data(deveui,ambient_temperature,recorded_at) VALUES('A840410000000001',21.5,'2026-01-02T03:04:05Z');
INSERT INTO app_settings(key,value) VALUES('upgrade_fixture','preserve');
"""
READ = """
SELECT username,password_hash,created_at FROM users WHERE username='upgrade-fixture';
SELECT deveui,name,type_id,created_at FROM devices WHERE name='upgrade fixture';
SELECT key,value FROM app_settings WHERE key='upgrade_fixture';
SELECT deveui,ambient_temperature,recorded_at FROM device_data WHERE recorded_at='2026-01-02T03:04:05Z';
"""


def checked(vm, shell, timeout=90):
    rc, output = vm.command(shell, timeout)
    if rc:
        raise RuntimeError(f'guest command returned {rc}')
    return output


def sql(vm, query, *, readonly=False):
    mode = '-readonly ' if readonly else ''
    return checked(vm, f"sqlite3 {mode}-batch -bail -cmd '.timeout 5000' {DB} <<'SQL'\n{query}\nSQL")


def cache_locked_packages(release, out):
    lock=release/'conf/full_raspberrypi_bcm27xx_bcm2712/files/usr/share/node-red/package-lock.json'
    cache=Path(os.environ.get('npm_config_cache',Path.home()/'.npm'))/'_cacache'
    archive=out/'npm-cache.tar'
    included=set()
    with tarfile.open(archive,'w') as tar:
        for package in json.loads(lock.read_text())['packages'].values():
            sri=package.get('integrity')
            if not sri or sri in included:
                continue
            algorithm, expected=sri.split('-',1)
            if algorithm not in ('sha512','sha1'):
                raise ValueError('unsupported npm lockfile integrity algorithm')
            digest=base64.b64decode(expected,validate=True).hex()
            name=Path('content-v2')/algorithm/digest[:2]/digest[2:4]/digest[4:]
            with (cache/name).open('rb') as f:
                if hashlib.file_digest(f,algorithm).hexdigest()!=digest:
                    raise ValueError('locked npm package digest mismatch')
            tar.add(cache/name,arcname=str(name))
            included.add(sri)
    return archive


OFFLINE_COMPANIONS = ('deploy-offline-runtime.js', 'deploy-archive.js', 'deploy-local-server.js')


def missing_companions(release):
    """Companions the release's deploy-offline.sh needs but its tree lacks.

    An older launcher runs on its own and needs none; one that runs the Node
    launcher fails at once on the gateway without all three.
    """
    launcher = release/'scripts/deploy-offline.sh'
    if not launcher.is_file() or OFFLINE_COMPANIONS[0] not in launcher.read_text():
        return []
    return [name for name in OFFLINE_COMPANIONS if not (release/'scripts'/name).exists()]


def build_media(release, directory, *, revision, extra_files=None, quiet=False):
    """Package the candidate with its own deployment scripts on a read-only USB disk."""
    missing = missing_companions(release)
    if missing:
        raise ValueError('deploy-offline.sh needs files the release lacks: ' + ', '.join(missing))
    out=directory/'upgrade'
    out.mkdir()
    env=dict(os.environ, REPO_ROOT=str(release),OUT_DIR=str(out),BUNDLE_SHA=revision[:8])
    stderr = subprocess.DEVNULL if quiet else None
    subprocess.run(['bash',release/'scripts/deploy-bundle.sh',release/'react_gui.tar.gz'],env=env,check=True,stdout=subprocess.DEVNULL,stderr=stderr)
    bundle=next(out.glob('*.tar.gz'))
    cache=cache_locked_packages(release,out)
    with bundle.open('rb') as stream:
        digest=hashlib.file_digest(stream,'sha256').hexdigest()
    checksum=out/'candidate.tar.gz.sha256'
    checksum.write_text(digest+'  candidate.tar.gz\n')
    files = {'npm-cache.tar': cache, 'candidate.tar.gz': bundle,
             'install.sh': release/'scripts/deploy-offline.sh', 'candidate.tar.gz.sha256': checksum}
    # deploy-offline.sh runs its Node launcher from its own directory, with
    # the companions deploy-push-bundle.sh pushes beside it.
    for companion in OFFLINE_COMPANIONS:
        source = release/'scripts'/companion
        if source.exists():
            files[companion] = source
    if extra_files:
        files.update(extra_files)
    disk = out/'upgrade-usb.img'
    with disk.open('wb') as stream:
        stream.truncate(max(64*1024**2, 2*sum(path.stat().st_size for path in files.values())))
    subprocess.run(['mkfs.vfat', disk], stdout=subprocess.DEVNULL, stderr=stderr, check=True)
    for name, path in files.items():
        subprocess.run(['mcopy', '-i', disk, path, '::'+name],
                       stdout=subprocess.DEVNULL, stderr=stderr, check=True)
    return disk


MOUNT_USB = """mkdir -p /tmp/upgrade-usb
if ! grep -q ' /tmp/upgrade-usb ' /proc/mounts; then
    mount -t vfat -o ro /dev/sda /tmp/upgrade-usb
fi
cd /tmp/upgrade-usb
"""

CANDIDATE_INSTALL = MOUNT_USB + """sha256sum -c candidate.tar.gz.sha256 >/dev/null
mkdir -p /tmp/osi-npm-cache/_cacache
tar -xf npm-cache.tar -C /tmp/osi-npm-cache/_cacache
export npm_config_cache=/tmp/osi-npm-cache npm_config_offline=true
sh install.sh /tmp/upgrade-usb/candidate.tar.gz --wait >/dev/null 2>&1
"""


def wait_for_login(vm):
    with timed(vm, 'login', 600):
        checked(vm, """for i in $(seq 1 180); do
code=$(curl -s --max-time 3 -o /dev/null -w '%{http_code}' -H 'Content-Type: application/json' -d '{}' http://127.0.0.1:1880/auth/login)
[ "$code" = 400 ] && exit 0
sleep 2
done
exit 1""", 600)


def wait_for_api(vm):
    budget = vm.API_WAIT_SECONDS
    # Allow the full budget even when each curl returns immediately: one poll
    # every two seconds. The echo leaves the guest clock at the first 401 for
    # boot_timing, which keeps the boot's phase timing after a slow wait.
    with timed(vm, 'api', budget) as began:
        answer = checked(vm, f"""for i in $(seq 1 {budget // 2}); do
    code=$(curl -s --max-time 2 -o /dev/null -w '%{{http_code}}' http://127.0.0.1:1880/api/me)
    [ "$code" = 401 ] && {{ echo "$(date '+%a %b %e %H:%M:%S %Y')"; exit 0; }}
    sleep 2
done
exit 1""", budget)
    if time.monotonic() - began > boot_timing.SLOW_API_SECONDS:
        boot_timing.keep(vm, answer)
    return answer


def run(vm, old_version, new_version, *, cut_at=None, transfer=None, release=None):
    if checked(vm,'uci get osi-server.cloud.firmware_version') != old_version:
        raise RuntimeError('old firmware version mismatch')
    from radio_suite import _api
    passwd = checked(vm, """head -c 24 /dev/urandom | hexdump -v -e '1/1 "%02x"'""")
    credentials = {'username':'upgrade-fixture','password':passwd}
    wait_for_login(vm)
    _api(vm,'POST','/auth/register',credentials)
    if not _api(vm,'POST','/auth/login',credentials).get('token'):
        raise RuntimeError('fixture login failed before upgrade')
    sql(vm, 'BEGIN IMMEDIATE;'+SEED+'COMMIT;')
    before = sql(vm, READ)
    if len(before.splitlines()) != 4:
        raise RuntimeError('incomplete fixture')
    if transfer:
        from boot_safety import check_transfer_cut
        check_transfer_cut(vm, release, transfer, before)
        return before
    old_stamp = vm.flows_receipt()[1] if cut_at else None
    if cut_at == CUT_RECEIPT:
        candidate_flows = release/'conf/full_raspberrypi_bcm27xx_bcm2712/files/usr/share/flows.json'
        shipped_old = hashlib.sha256(candidate_flows.read_bytes()).hexdigest().encode()
        shipped_init = hashlib.sha256((release/INIT).read_bytes()).hexdigest().encode()
        writer = candidate_flows.parent/'node-red/osi-atomic-write.js'
        shipped_writer = hashlib.sha256(writer.read_bytes()).hexdigest().encode()
    code, receipt = vm.command('set -e\n'+CANDIDATE_INSTALL, 2400, until=cut_at)
    if cut_at is not None and code is None:
        # This is the candidate init's first publication on the upgraded
        # payload. The installer is still running, so cut without a guest call.
        if cut_at == CUT_RECEIPT:
            receipt = verify_disk(vm, receipt, phase='committed', factory=False,
                                  old_stamp=old_stamp, shipped_old=shipped_old,
                                  shipped_init=shipped_init, shipped_writer=shipped_writer)
        else:
            vm.stop(cut=True)
            if receipt[1] in (b'image', old_stamp):
                raise RuntimeError('upgrade commit did not name a new deployed payload')
            vm.verify_cut_disk('upgrade commit', receipt)
        vm.start()
        wait_for_api(vm)
        vm.verify_flows_receipt(receipt)
        if checked(vm, 'cat /srv/node-red/payloads/active/release-version') != new_version:
            raise RuntimeError('recovery did not retain the candidate release payload')
    elif cut_at is not None and code == 0:
        raise RuntimeError('offline installer finished without a flows commit marker')
    elif code:
        _, info=vm.command("""sync
f=$(ls -t /data/deploy-*.log | head -1)
for reason in ENOTCACHED ENOENT EAI_AGAIN ERESOLVE EACCES SQLITE_BUSY SQLITE_CONSTRAINT 'npm install failed' 'insufficient disk' 'payload verification failed' 'migration failed'; do
grep -Fq "$reason" "$f" && echo "$reason"
done""")
        (vm.receipts/'upgrade-diagnostics.log').write_text(info+'\n')
        raise RuntimeError('offline installer exited '+str(code)+'; '+info.replace('\n',', '))
    if cut_at is None:
        vm.reboot()
    with timed(vm, 'farm page', 600):
        checked(vm,"for i in $(seq 1 180); do test -s /data/db/farming.db && wget -q -O /dev/null http://127.0.0.1:1880/gui/ && exit 0; sleep 3; done; exit 1",600)
    # The cut can precede the installer's successful health receipt and
    # its firmware version write. Check the active payload and API above.
    if cut_at is None and checked(vm,'uci get osi-server.cloud.firmware_version') != new_version:
        raise RuntimeError('upgraded firmware version mismatch')
    checked(vm,'ip addr add 192.0.2.15/24 dev br-lan 2>/dev/null || ip addr add 192.0.2.15/24 dev eth0')
    wait_for_login(vm)
    if not _api(vm,'POST','/auth/login',credentials).get('token'):
        raise RuntimeError('fixture login failed after upgrade')
    if sql(vm, READ) != before or sql(vm,'PRAGMA integrity_check;') != 'ok':
        raise RuntimeError('upgraded database or persisted fixture mismatch')
    return before
