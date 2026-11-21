"""Exercise the offline upgrade of a disposable customer-line 0.7.0 image."""
from datetime import UTC, datetime
import hashlib
import json
import re
import shlex
import tarfile
import time

from suite_vm import Guest, external_path
from upgrade_suite import DB, MOUNT_USB, build_media, checked, sql

FILES = (
    'customer.tar.gz', 'customer.tar.gz.sha256', 'customer-install.sh', 'customer-cache.tar',
    'populate.sql', 'snapshot.sql', 'chirpstack-fixture.cjs',
)
LEDGER = """SELECT count(*) FROM schema_migrations;
SELECT count(*) FROM schema_migrations WHERE status <> 'applied';
SELECT name FROM schema_migrations WHERE version = 76;
"""
ARCHIVE = 'sdi12_transmissions.sql'
PROVENANCE = 'fixture-provenance.json'
QUALIFICATION_SCOPE = (
    'Exact factory archive and 0.8.1 overlay only. '
    'The factory ROM GUI differs from the recorded field installation.'
)
SHA256 = re.compile(r'[0-9a-f]{64}')
REVISION = re.compile(r'[0-9a-f]{40}')
POLL_SECONDS = 15
IDLE_SECONDS = 15 * 60
HARD_SECONDS = 90 * 60
INSTALL_PHASES = ('starting', 'dependencies', 'migration', 'activation')
PROGRESS = re.compile(r'([0-3]) (-|[0-9]{1,4}) ([0-9]{1,4}) ([0-9]{1,4}) (-|[0-9]{1,3})')
LEDGER_HEAD = (
    f"sqlite3 -readonly -batch -bail -cmd '.timeout 500' {DB} "
    "\"SELECT coalesce(max(version),0) FROM schema_migrations WHERE status='applied';\" "
    "2>/dev/null || printf '%s' -"
)
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


class FixtureFailure(RuntimeError):
    """A fixed diagnostic or validated numeric result safe for shared output."""


def verified_inputs(image, source, release):
    checksums = {}
    for line in external_path(source/'SHA256SUMS').read_text().splitlines():
        parts = line.split(maxsplit=1)
        if len(parts) != 2 or not re.fullmatch(r'[0-9a-f]{64}', parts[0]):
            raise ValueError('invalid private SHA256SUMS line')
        digest, name = parts
        name = name.lstrip('*')
        if name in checksums:
            raise ValueError('duplicate private SHA256SUMS entry')
        checksums[name] = digest
    files = {name: external_path(source/name) for name in (*FILES, PROVENANCE)}
    for name, path in [(image.name, external_path(image)), *files.items()]:
        with path.open('rb') as stream:
            if hashlib.file_digest(stream, 'sha256').hexdigest() != checksums.get(name):
                raise ValueError('private fixture input SHA-256 mismatch')
    provenance = json.loads(files.pop(PROVENANCE).read_text())
    pins = {'factory_image_sha256': image.name, 'legacy_bundle_sha256': 'customer.tar.gz'}
    if not isinstance(provenance, dict) or set(provenance) != {'rom_gui_sha256', 'legacy_revision', *pins}:
        raise ValueError('invalid private fixture provenance')
    rom, revision = provenance['rom_gui_sha256'], provenance['legacy_revision']
    if not (isinstance(rom, str) and SHA256.fullmatch(rom)
            and isinstance(revision, str) and REVISION.fullmatch(revision)):
        raise ValueError('invalid private fixture provenance digest or revision')
    if any(provenance[key] != checksums[name] for key, name in pins.items()):
        raise ValueError('private factory or overlay differs from the preparation pin')

    directory = 'database/migrations/ordered'
    old_archive = f'0076__{ARCHIVE}'
    with tarfile.open(files['customer.tar.gz'], 'r:gz') as bundle:
        def member(name):
            path = f'{directory}/{name}'
            item = next((entry for entry in bundle.getmembers()
                         if entry.name.removeprefix('./') == path), None)
            if item is None or not item.isfile():
                raise ValueError('legacy bundle migration input missing')
            with bundle.extractfile(item) as stream:
                return stream.read()

        legacy_checksum = hashlib.sha256(member(old_archive)).hexdigest()
        if json.loads(member('CHECKSUMS.json')).get(old_archive) != legacy_checksum:
            raise ValueError('legacy archive migration does not match its manifest')
    candidate_directory = release/directory
    candidate_archive = f'0080__{ARCHIVE}'
    candidate_manifest = json.loads((candidate_directory/'CHECKSUMS.json').read_text())
    if (candidate_manifest.get(candidate_archive) != legacy_checksum
            or hashlib.sha256((candidate_directory/candidate_archive).read_bytes()).hexdigest() != legacy_checksum):
        raise ValueError('legacy archive migration does not match candidate migration 0080')
    if files['customer.tar.gz.sha256'].read_text().split()[0] != checksums['customer.tar.gz']:
        raise ValueError('legacy bundle does not match its installer sidecar')

    identity = dict(provenance, legacy_archive_migration_sha256=legacy_checksum,
                    inputs_sha256={name: checksums[name] for name in (*FILES, PROVENANCE)})
    return files, identity


def ledger_ok(vm):
    if sql(vm, 'PRAGMA integrity_check; PRAGMA foreign_key_check;') != 'ok':
        raise FixtureFailure('private fixture SQLite integrity or foreign key check failed')


def version(vm, osi, chirpstack):
    actual = checked(vm, 'uci get osi-server.cloud.firmware_version; chirpstack --version')
    if actual.splitlines() != [osi, f'chirpstack {chirpstack}']:
        raise FixtureFailure('private fixture guest version mismatch')


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
        raise FixtureFailure('private synthetic fixture census mismatch')


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
        raise FixtureFailure('private fixture snapshot incomplete')
    return row_hash, registrations


def write_receipt(path, **fields):
    with path.open('a') as log:
        print(json.dumps({'utc': datetime.now(UTC).isoformat(timespec='seconds'), **fields}), file=log)


def track_install(vm, log, name, installer, bundle, cache):
    directory = f'/tmp/osi-fixture-{name}'
    deploy_log = f'/data/deploy-emulator-{name}.log'
    initial = checked(vm, LEDGER_HEAD)
    if not re.fullmatch(r'-|[0-9]{1,4}', initial):
        raise FixtureFailure('invalid starting ledger receipt')
    starting_head = None if initial == '-' else int(initial)
    start = time.monotonic()
    latest = start
    high_water = [0, starting_head or 0, 0, 0]
    status = dict(phase=INSTALL_PHASES[0], current_ledger=starting_head,
                  reference_count=0, baseline_comparisons=0)

    def record(event, **fields):
        write_receipt(log, leg=name, event=event, elapsed_seconds=round(time.monotonic()-start),
                      starting_ledger=starting_head, **fields)

    record('start', **status)
    checked(vm, f"""set -e
{MOUNT_USB}
mkdir -p {directory}/cache/_cacache {directory}/tmp
tar -xf {cache} -C {directory}/cache/_cacache
(
    set +e
    export npm_config_cache={directory}/cache npm_config_offline=true
    export TMPDIR={directory}/tmp DEPLOY_OFFLINE_TS=emulator-{name}
    sh {installer} /tmp/upgrade-usb/{bundle} --wait
    rc=$?
    printf '%s\\n' "$rc" > {directory}/rc.tmp && mv {directory}/rc.tmp {directory}/rc
) </dev/null >/dev/null 2>&1 &
""", 180)
    probe = fr"""phase=0
f={deploy_log}
if test -f "$f"; then
    if grep -Fq -- '--- Node-RED runtime dependencies ---' "$f"; then phase=1; fi
    if grep -Fq -- '--- Edge schema migration runner ---' "$f"; then phase=2; fi
    if grep -Fq -- '--- Flip payload + local health self-check' "$f"; then phase=3; fi
fi
head=$({LEDGER_HEAD})
refs=$(find {directory}/tmp -type f -name 'ref-[0-9][0-9][0-9][0-9].db' 2>/dev/null | awk 'END {{print NR}}')
comparisons=$(grep -c '^\[baseline\] N=[0-9]' "$f" 2>/dev/null) || comparisons=0
rc=-
if test -s {directory}/rc; then rc=$(cat {directory}/rc); fi
printf '%s %s %s %s %s\n' "$phase" "$head" "$refs" "$comparisons" "$rc"
"""
    while True:
        now = time.monotonic()
        remaining = min(start + HARD_SECONDS, latest + IDLE_SECONDS) - now
        if remaining <= 0:
            event = 'hard-timeout' if now >= start + HARD_SECONDS else 'no-progress-timeout'
            record(event, last_progress_seconds=round(latest-start), installer_rc=None, **status)
            limit = HARD_SECONDS if event == 'hard-timeout' else IDLE_SECONDS
            raise FixtureFailure(f'{name} install {event} after {limit} seconds')
        try:
            output = checked(vm, probe, min(40, remaining))
        except (TimeoutError, OSError, RuntimeError):
            record('progress-probe-failed', installer_rc=None, **status)
            raise FixtureFailure(f'{name} installer progress probe failed') from None
        receipt = PROGRESS.fullmatch(output)
        if receipt is None:
            raise FixtureFailure('invalid installer progress receipt')
        phase, head, refs, comparisons, rc = receipt.groups()
        current_head = None if head == '-' else int(head)
        values = [int(phase), current_head or 0, int(refs), int(comparisons)]
        status = dict(phase=INSTALL_PHASES[values[0]], current_ledger=current_head,
                      reference_count=values[2], baseline_comparisons=values[3])
        if any(current > previous for current, previous in zip(values, high_water)):
            latest = time.monotonic()
            high_water = [max(current, previous) for current, previous in zip(values, high_water)]
            record('progress', **status)
        if rc != '-':
            code = int(rc)
            if code > 255:
                raise FixtureFailure('invalid installer exit status')
            record('exit', installer_rc=code, **status)
            if code:
                raise FixtureFailure(f'{name} installer returned {code}')
            return
        now = time.monotonic()
        time.sleep(max(0, min(POLL_SECONDS, start + HARD_SECONDS - now, latest + IDLE_SECONDS - now)))


def run(args, scratch, receipts, release, ready):
    work = scratch/'customer-line'
    work.mkdir()
    evidence = receipts/'customer-line'
    evidence.mkdir(mode=0o700)
    log = evidence/'progress.jsonl'
    write_receipt(log, event='phase', phase='prepare')
    try:
        files, identity = verified_inputs(args.customer_image, args.customer_source, release)
    except (OSError, ValueError, RuntimeError, tarfile.TarError, IndexError, AttributeError):
        raise FixtureFailure('private fixture provenance, manifest or checksum verification failed') from None
    identity['candidate_revision'] = args.release_revision
    (evidence/'inputs.json').write_text(json.dumps(identity, indent=2)+'\n')
    media = build_media(release, work, revision=args.release_revision, extra_files=files, quiet=True)
    write_receipt(log, event='phase', phase='boot-0.7.0')
    vm = Guest(work/'guest', args.customer_image, args.qemu, args.ram, upgrade=media,
               receipts=evidence, private=True)
    try:
        vm.start()
        ready(vm)
        version(vm, '0.7.0', '4.12.1')
        checked(vm, FILESYSTEM)
        if sql(vm, 'SELECT (SELECT count(*) FROM users)+(SELECT count(*) FROM devices)+(SELECT count(*) FROM device_data);') != '0':
            raise FixtureFailure('private factory image contains persisted data')
        rom_asset = checked(vm, 'sha256sum /rom/usr/lib/node-red/gui/index.html | cut -d " " -f 1')
        if rom_asset != identity['rom_gui_sha256']:
            raise FixtureFailure('private guest ROM GUI differs from the qualification pin')
        track_install(vm, log, 'legacy', 'customer-install.sh', 'customer.tar.gz', 'customer-cache.tar')
        ready(vm)
        version(vm, '0.8.1', '4.12.1')
        if not rom_asset or rom_asset != checked(vm, 'sha256sum /rom/usr/lib/node-red/gui/index.html | cut -d " " -f 1'):
            raise FixtureFailure('customer overlay changed the factory GUI')
        old_stamp = checked(vm, "readlink /srv/node-red/payloads/active")
        if sql(vm, LEDGER).splitlines() != ['76', '0', f'0076__{ARCHIVE}']:
            raise FixtureFailure('old customer-line ledger mismatch')
        old_archive_checksum = sql(vm, 'SELECT checksum FROM schema_migrations WHERE version = 76;')
        if old_archive_checksum != identity['legacy_archive_migration_sha256']:
            raise FixtureFailure('legacy guest ledger differs from the pinned overlay bundle')
        write_receipt(log, event='phase', phase='legacy-ledger-verified', current_ledger=76)
        write_receipt(log, event='phase', phase='load-synthetic-data')
        checked(vm, f'set -e\n{MOUNT_USB}\nsqlite3 -batch -bail {DB} < populate.sql')
        expect_data(vm)
        ledger_ok(vm)
        before = snapshot(vm, 'create')
        track_install(vm, log, 'candidate', 'install.sh', 'candidate.tar.gz', 'npm-cache.tar')
        checked(vm, r"""set -e
f=/data/deploy-emulator-candidate.log
grep -Fq 'remapped 1 ledger row(s)' "$f"
backup=$(sed -n 's/.*persistent pre-reconciliation backup: \([^ ]*\) .*/\1/p' "$f")
test -s "$backup"
""")
        write_receipt(log, event='phase', phase='verify-after-reboot')
        vm.reboot()
        ready(vm)
        version(vm, args.osi_version, args.chirpstack_version)
        checked(vm, 'test "$(readlink /srv/node-red/payloads/active)" != ' + shlex.quote(old_stamp))
        checked(vm, PAYLOAD)
        if sql(vm, LEDGER + "SELECT name FROM schema_migrations WHERE version = 80;").splitlines()[1:] != [
            '0', '0076__conditional_irrigation.sql', f'0080__{ARCHIVE}',
        ]:
            raise FixtureFailure('candidate ledger did not remap migration 76 to 80')
        if sql(vm, 'SELECT checksum FROM schema_migrations WHERE version = 80;') != old_archive_checksum:
            raise FixtureFailure('archive migration checksum changed during remap')
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
                raise FixtureFailure('legacy archive rows unexpectedly acquired uplink keys')
        expect_data(vm)
        ledger_ok(vm)
        if snapshot(vm, 'snapshot') != before:
            raise FixtureFailure('private synthetic database or radio registrations changed')
    finally:
        vm.stop()
    write_receipt(evidence/'qualification.json', result='PASS', scope=QUALIFICATION_SCOPE, **identity,
                  legacy_ledger=76, archive_migration=80, osi_version=args.osi_version,
                  chirpstack_version=args.chirpstack_version)
    return 'ledger 76→80; synthetic rows, radio registrations and active payload verified after reboot'
