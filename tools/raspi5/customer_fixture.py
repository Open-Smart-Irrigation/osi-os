"""Exercise the offline upgrade of a disposable customer-line 0.7.0 image."""
import hashlib
import json
import os
from pathlib import Path
import re
import shlex

from suite_vm import Guest
from upgrade_suite import CANDIDATE_INSTALL, DB, MOUNT_USB, build_media, checked, sql

FILES = (
    'customer.tar.gz', 'customer.tar.gz.sha256', 'customer-install.sh', 'customer-cache.tar',
    'populate.sql', 'snapshot.sql', 'chirpstack-fixture.cjs',
)
LEDGER = """SELECT count(*) FROM schema_migrations;
SELECT count(*) FROM schema_migrations WHERE status <> 'applied';
SELECT name FROM schema_migrations WHERE version = 76;
"""
ARCHIVE = 'sdi12_transmissions.sql'
FILESYSTEM = """
data_fs=$(df -P /data | awk 'NR==2 {print $1}')
test -n "$data_fs" && test "$data_fs" != "$(df -P /rom | awk 'NR==2 {print $1}')" &&
awk '$3=="f2fs" {found=1} END {exit !found}' /proc/mounts &&
df -Pk /data | awk 'END {exit !($(NF-2)>1048576)}'
"""
PAYLOAD = """node <<'JS'
const assert = require('node:assert/strict');
const { existsSync } = require('node:fs');
const root = '/srv/node-red';
const swap = require(root + '/.payload-swap.js');
const active = swap.activeStamp(root);
const state = swap.readPayloadState(root);
assert.ok(active);
assert.equal(state?.active, active);
assert.equal(state?.state, 'healthy');
assert.equal(swap.readHealth(root, active)?.state, 'healthy');
assert.ok(swap.verifyPair(root, active, '/usr/lib/node-red/gui'));
assert.ok(swap.payloadTrusted(root, active));
assert.ok(!existsSync(root + '/DEPLOY-HELD'));
console.log(active);
JS
"""


def verified_inputs(image, source):
    checksums = {}
    for line in (source/'SHA256SUMS').read_text().splitlines():
        parts = line.split(maxsplit=1)
        if len(parts) != 2 or not re.fullmatch(r'[0-9a-f]{64}', parts[0]):
            raise ValueError('invalid private SHA256SUMS line')
        digest, name = parts
        name = name.lstrip('*')
        if name in checksums:
            raise ValueError('duplicate private SHA256SUMS entry')
        checksums[name] = digest
    for path in (image, *(source/name for name in FILES)):
        with path.open('rb') as stream:
            if hashlib.file_digest(stream, 'sha256').hexdigest() != checksums.get(path.name):
                raise ValueError('private fixture input SHA-256 mismatch')
    return {name: source/name for name in FILES}, checksums[image.name]


def ledger_ok(vm):
    if sql(vm, 'PRAGMA integrity_check; PRAGMA foreign_key_check;') != 'ok':
        raise RuntimeError('private fixture SQLite integrity or foreign key check failed')


def version(vm, osi, chirpstack):
    actual = checked(vm, 'uci get osi-server.cloud.firmware_version; chirpstack --version')
    if actual.splitlines() != [osi, f'chirpstack {chirpstack}']:
        raise RuntimeError('private fixture guest version mismatch')


def expect_data(vm):
    counts = sql(vm, """SELECT count(*) FROM users;
SELECT count(*) FROM irrigation_zones;
SELECT count(*) FROM devices;
SELECT count(*) FROM device_data;
SELECT count(*) FROM tensiomark_observations;
SELECT count(*) FROM sdi12_transmissions;
SELECT count(*) > 0 FROM sync_outbox;
SELECT count(*) FROM sync_link_state WHERE linked <> 0 OR server_url IS NOT NULL;
""")
    if counts.splitlines() != ['1', '1', '3', '97', '1', '4', '1', '0']:
        raise RuntimeError('private synthetic fixture census mismatch')


def snapshot(vm, radio_mode):
    receipt = checked(vm, f"""set -e
{MOUNT_USB}
radio_db=/srv/chirpstack/chirpstack.sqlite
test -s "$radio_db"
test "$(sqlite3 -readonly -batch -bail -cmd '.timeout 5000' "$radio_db" 'PRAGMA integrity_check;')" = ok
test "$(redis-cli ping)" = PONG
sqlite3 -readonly -batch -bail {DB} < snapshot.sql > /tmp/fixture.rows
test -s /tmp/fixture.rows
sha256sum /tmp/fixture.rows | cut -d ' ' -f 1
node chirpstack-fixture.cjs {radio_mode}
""", 180)
    row_hash, _, radio = receipt.partition('\n')
    registrations = json.loads(radio)
    if not re.fullmatch(r'[0-9a-f]{64}', row_hash) or not isinstance(registrations, list) or len(registrations) != 3:
        raise RuntimeError('private fixture snapshot incomplete')
    return row_hash, registrations


def run(args, directory, release, ready):
    image = Path(os.environ['OSI_RASPI5_CUSTOMER_IMAGE'])
    source = Path(os.environ['OSI_RASPI5_CUSTOMER_FIXTURE_DIR'])
    work = directory/'customer-line'
    work.mkdir()
    try:
        files, image_digest = verified_inputs(image, source)
    except (OSError, ValueError):
        raise RuntimeError('private fixture input missing or SHA256SUMS verification failed') from None
    (work/'image.sha256').write_text(image_digest+'\n')
    media = build_media(release, work, revision=args.release_revision, extra_files=files)
    vm = Guest(work/'guest', image, args.qemu, args.ram, upgrade=media)
    try:
        vm.start()
        ready(vm)
        version(vm, '0.7.0', '4.12.1')
        checked(vm, FILESYSTEM)
        if sql(vm, 'SELECT (SELECT count(*) FROM users)+(SELECT count(*) FROM devices)+(SELECT count(*) FROM device_data);') != '0':
            raise RuntimeError('private factory image contains persisted data')
        rom_asset = checked(vm, 'sha256sum /rom/usr/lib/node-red/gui/index.html | cut -d " " -f 1')
        checked(vm, f"""set -e
{MOUNT_USB}
mkdir -p /tmp/customer-cache/_cacache
tar -xf customer-cache.tar -C /tmp/customer-cache/_cacache
export npm_config_cache=/tmp/customer-cache npm_config_offline=true
sh customer-install.sh /tmp/upgrade-usb/customer.tar.gz --wait
""", 2400)
        ready(vm)
        version(vm, '0.8.1', '4.12.1')
        if not rom_asset or rom_asset != checked(vm, 'sha256sum /rom/usr/lib/node-red/gui/index.html | cut -d " " -f 1'):
            raise RuntimeError('customer overlay changed the factory GUI')
        old_stamp = checked(vm, "readlink /srv/node-red/payloads/active")
        if sql(vm, LEDGER).splitlines() != ['76', '0', f'0076__{ARCHIVE}']:
            raise RuntimeError('old customer-line ledger mismatch')
        old_archive_checksum = sql(vm, 'SELECT checksum FROM schema_migrations WHERE version = 76;')
        checked(vm, f'set -e\n{MOUNT_USB}\nsqlite3 -batch -bail {DB} < populate.sql')
        expect_data(vm)
        ledger_ok(vm)
        before = snapshot(vm, 'create')
        checked(vm, 'set -e\n'+CANDIDATE_INSTALL, 2400)
        checked(vm, r"""set -e
f=$(ls -t /data/deploy-*.log | head -1)
grep -Fq 'remapped 1 ledger row(s)' "$f"
backup=$(sed -n 's/.*persistent pre-reconciliation backup: \([^ ]*\) .*/\1/p' "$f")
test -s "$backup"
""")
        vm.reboot()
        ready(vm)
        version(vm, args.osi_version, args.chirpstack_version)
        checked(vm, 'test "$(readlink /srv/node-red/payloads/active)" != ' + shlex.quote(old_stamp))
        checked(vm, PAYLOAD)
        if sql(vm, LEDGER + "SELECT name FROM schema_migrations WHERE version = 80;").splitlines()[1:] != [
            '0', '0076__conditional_irrigation.sql', f'0080__{ARCHIVE}',
        ]:
            raise RuntimeError('candidate ledger did not remap migration 76 to 80')
        if sql(vm, 'SELECT checksum FROM schema_migrations WHERE version = 80;') != old_archive_checksum:
            raise RuntimeError('archive migration checksum changed during remap')
        checked(vm, f"""set -e
{MOUNT_USB}
sha256sum -c candidate.tar.gz.sha256 >/dev/null
mkdir -p /tmp/verify-candidate
tar -xzf candidate.tar.gz -C /tmp/verify-candidate
sqlite3 {DB} ".backup /tmp/verify-candidate/farming.db"
node /tmp/verify-candidate/scripts/verify-head-cli.js /tmp/verify-candidate/farming.db >/dev/null
""", 180)
        if sql(vm, "SELECT count(*) FROM pragma_table_info('sdi12_transmissions') WHERE name = 'uplink_key';") == '1':
            if sql(vm, 'SELECT count(*) FROM sdi12_transmissions WHERE uplink_key IS NOT NULL;') != '0':
                raise RuntimeError('legacy archive rows unexpectedly acquired uplink keys')
        expect_data(vm)
        ledger_ok(vm)
        if snapshot(vm, 'snapshot') != before:
            raise RuntimeError('private synthetic database or radio registrations changed')
        return 'ledger 76→80; synthetic rows, radio registrations and active payload verified after reboot'
    finally:
        vm.stop()
