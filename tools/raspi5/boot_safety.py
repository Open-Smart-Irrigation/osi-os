"""Guest boot and recovery probes for the #714 release gate."""
import hashlib
import json
import re
import sqlite3

from upgrade_suite import CANDIDATE_INSTALL, READ, checked, sql, wait_for_api, wait_for_login


FLOW_ROOT = '/srv/node-red'
BOOT_FILES = {
    '/srv/node-red/settings.js': ('feeds/chirpstack-openwrt-feed/apps/node-red/files/settings.js', '644'),
    '/etc/init.d/node-red': ('feeds/chirpstack-openwrt-feed/apps/node-red/files/node-red.init', '755'),
    '/srv/node-red/chirpstack-bootstrap.js': ('scripts/chirpstack-bootstrap.js', '644'),
    '/etc/init.d/osi-bootstrap': ('conf/full_raspberrypi_bcm27xx_bcm2712/files/etc/init.d/osi-bootstrap', '755'),
    '/usr/share/node-red/chirpstack-bootstrap.js': (None, None),
}
TRANSFER_TARGETS = {
    'settings': '/srv/node-red/settings.js',
    'init': '/etc/init.d/node-red',
    'bootstrap': '/srv/node-red/chirpstack-bootstrap.js',
}

PARTIAL_DOWNLOAD = rb'flows-cut: partial download (settings|init|bootstrap)\r?\n'
PARTIAL_CURL = """mkdir -p /tmp/flows-cut-bin
cat >/tmp/flows-cut-bin/curl <<'SH'
#!/bin/sh
if [ "$#" -eq 3 ] && [ "$1" = -fsSLo ]; then
    case "$2:$3" in
        *.osi-stage.*:*/settings.js) entry=settings ;;
        *.osi-stage.*:*/node-red.init) entry=init ;;
        *.osi-stage.*:*/scripts/chirpstack-bootstrap.js) entry=bootstrap ;;
        *) entry= ;;
    esac
    if [ "$entry" = "$OSI_TEST_TRANSFER" ]; then
        printf 'partial download' > "$2" || exit 1
        printf 'flows-cut: partial download %s\\n' "$entry" >/dev/console
        kill -STOP "$$"
        exit 97
    fi
fi
exec /usr/bin/curl "$@"
SH
chmod 755 /tmp/flows-cut-bin/curl
export PATH="/tmp/flows-cut-bin:$PATH"
"""

TRIGGER_MIGRATION = '0073__zone_env_rain_quality_sync.sql'
TRIGGER_QUERY = """SELECT name, sql FROM sqlite_schema WHERE type = 'trigger' AND name IN
    ('trg_dp_zone_env_outbox_ai','trg_dp_zone_env_outbox_au') ORDER BY name"""
HOLD_INSTRUCTION = 'You must re-run the deploy for this release before Node-RED can start.'


def migrated_triggers(release):
    directory = release/'database/migrations/ordered'
    script = (directory/TRIGGER_MIGRATION).read_bytes()
    digest = hashlib.sha256(script).hexdigest()
    if digest != json.loads((directory/'CHECKSUMS.json').read_text())[TRIGGER_MIGRATION]:
        raise RuntimeError('migration 0073 failed its release checksum')
    db = sqlite3.connect(':memory:')
    try:
        db.executescript('CREATE TABLE zone_daily_environment (sync_version INTEGER);')
        db.executescript(script.decode())
        triggers = dict(db.execute(TRIGGER_QUERY))
    finally:
        db.close()
    if len(triggers) != 2:
        raise RuntimeError('migration 0073 did not create both zone-env outbox triggers')
    return digest, triggers


def assert_migrated_triggers(vm, expected, phase):
    checksum, bodies = expected
    applied = sql(vm, "SELECT checksum FROM schema_migrations WHERE version=73 AND status='applied';", readonly=True)
    if applied != checksum:
        raise RuntimeError(f'{phase}: database lacks the pinned 0073 ledger entry')
    query = f'SELECT json_group_object(name, sql) FROM ({TRIGGER_QUERY});'
    actual = json.loads(sql(vm, query, readonly=True))
    for name, text in bodies.items():
        if actual.get(name) != text:
            raise RuntimeError(f'{phase}: {name} differs from the migrated 0073 body')
    receipt = vm.receipts/'trigger-0073-receipts.jsonl'
    with receipt.open('a') as log:
        print(json.dumps({'phase': phase, 'migration': checksum,
              'triggers': {name: hashlib.sha256(text.encode()).hexdigest()
                           for name, text in actual.items()}}), file=log)


def wait_for_schema_init(vm):
    checked(vm, """for i in $(seq 1 100); do
    logread | grep -Fq 'sync-init: schema init complete' && exit 0
    sleep 2
done
exit 1""", 300)


def zero_live_flows(vm, stamp):
    size = int(checked(vm, 'wc -c < /srv/node-red/flows.json'))
    if size <= 0:
        raise RuntimeError('live flow file is empty before zeroing')
    checked(vm, """set -e
/etc/init.d/node-red stop
node - <<'JS'
const fs = require('fs');
const live = fs.realpathSync('/srv/node-red/flows.json');
fs.writeFileSync(live, Buffer.alloc(fs.statSync(live).size));
JS
sync""")
    return hashlib.sha256(bytes(size)).hexdigest().encode(), stamp


def verify_zero_recovery(vm, release, before):
    expected_triggers = migrated_triggers(release)
    wait_for_schema_init(vm)
    wait_for_api(vm)
    assert_migrated_triggers(vm, expected_triggers, 'first post-upgrade start')
    _, stamp = vm.flows_receipt()
    if stamp == b'image':
        raise RuntimeError('upgrade left the firmware flows active')
    zeros = zero_live_flows(vm, stamp)
    vm.stop(cut=True)
    vm.verify_cut_disk('zeroed deployed flows before recovery', zeros,
                       inspect=lambda guest: assert_migrated_triggers(guest, expected_triggers, 'disk before recovery'))
    vm.start()
    wait_for_schema_init(vm)
    wait_for_api(vm)
    if vm.flows_receipt()[1] != stamp:
        raise RuntimeError('recovery left the candidate payload')
    checked(vm, """set -e
logread | grep -F 'restored flows.json (zeroed)' | grep -Fq '/flows.pristine.json'
node - <<'JS'
const fs = require('fs');
const path = require('path');
const live = fs.realpathSync('/srv/node-red/flows.json');
const pristine = path.join(path.dirname(live), 'flows.pristine.json');
const boot = file => JSON.parse(fs.readFileSync(file, 'utf8')).find(node => node.id === 'sync-init-fn')?.func;
if (!boot(live) || boot(live) !== boot(pristine) || boot(live) === boot('/usr/share/flows.json')) process.exit(1);
JS""")
    assert_migrated_triggers(vm, expected_triggers, 'after pristine recovery')
    if sql(vm, READ) != before or sql(vm, 'PRAGMA integrity_check;') != 'ok':
        raise RuntimeError('fixture changed during flow recovery on the older image')


def verify_missing_pristine_hold(vm):
    wait_for_schema_init(vm)
    wait_for_api(vm)
    prior = vm.flows_receipt()
    checked(vm, """set -e
active=$(readlink -f /srv/node-red/payloads/active)
test -s "$active/flows.pristine.json"
test -s "$active/flows-seed.json"
/etc/init.d/node-red stop
rm "$active/flows.pristine.json"
sync""")

    def missing_on_disk(guest):
        checked(guest, """set -e
active=$(readlink -f /srv/node-red/payloads/active)
test ! -e "$active/flows.pristine.json"
test -s "$active/flows-seed.json"
test -s "$active/compatibility.json"
test ! -e /srv/node-red/DEPLOY-HELD""")

    # A working farm stays online when only its recovery source is missing.
    vm.stop(cut=True)
    vm.verify_cut_disk('missing pristine copy with healthy live flows', prior, inspect=missing_on_disk)
    vm.start()
    wait_for_schema_init(vm)
    wait_for_api(vm)
    checked(vm, """set -e
logread | grep -F 'WARN: Pristine flow recovery unavailable' | grep -Fq 'pristine flows file or its seal is missing'
test ! -e /srv/node-red/DEPLOY-HELD
node - <<'JS'
const fs = require('fs');
const root = '/srv/node-red';
const state = JSON.parse(fs.readFileSync(root + '/payload-state.json', 'utf8'));
const stamp = require('path').basename(fs.realpathSync(root + '/payloads/active'));
if (state.state === 'held' || state.active !== stamp ||
    !state.flow_recovery_warning?.includes('pristine flows file or its seal is missing')) process.exit(1);
JS""")
    if vm.flows_receipt() != prior:
        raise RuntimeError('warning boot changed healthy live flows')

    zeros = zero_live_flows(vm, prior[1])
    vm.stop(cut=True)
    vm.verify_cut_disk('missing pristine copy with zeroed live flows', zeros, inspect=missing_on_disk)
    vm.start()
    checked(vm, rf"""set -e
for i in $(seq 1 100); do
    if logread | grep -F 'HELD: Node-RED stopped.' | grep -Fq '{HOLD_INSTRUCTION}'; then
        break
    fi
    sleep 2
done
logread | grep -F 'HELD: Node-RED stopped.' | grep -Fq 'pristine flows file or its seal is missing'
grep -Fq '{HOLD_INSTRUCTION}' /srv/node-red/DEPLOY-HELD
node - <<'JS'
const fs = require('fs');
const path = require('path');
const root = '{FLOW_ROOT}';
const state = JSON.parse(fs.readFileSync(path.join(root, 'payload-state.json'), 'utf8'));
const note = fs.readFileSync(path.join(root, 'DEPLOY-HELD'), 'utf8').trim();
const stamp = path.basename(fs.realpathSync(path.join(root, 'payloads/active')));
if (state.state !== 'held' || state.active !== stamp || state.writer !== 'flow-recovery' ||
    state.reason !== note || !note.includes('pristine flows file or its seal is missing') ||
    !note.includes('{HOLD_INSTRUCTION}')) process.exit(1);
const live = fs.readdirSync('/proc').filter(pid => /^\d+$/.test(pid)).some(pid => {{
    try {{
        return fs.readFileSync('/proc/' + pid + '/cmdline', 'utf8').split(String.fromCharCode(0))
            .includes('/usr/lib/node/node-red/red.js');
    }} catch (error) {{
        if (error.code !== 'ENOENT' && error.code !== 'ESRCH') throw error;
        return false;
    }}
}});
if (live) process.exit(1);
JS
code=$(curl -s --max-time 2 -o /dev/null -w '%{{http_code}}' http://127.0.0.1:1880/api/me || true)
[ "$code" = 000 ]""", 300)
    if vm.flows_receipt() != zeros:
        raise RuntimeError('held boot changed the rejected live flows')
    hold = checked(vm, 'cat /srv/node-red/DEPLOY-HELD')
    (vm.receipts/'deploy-held.log').write_text(hold + '\n')


def boot_files_receipt(vm):
    output = checked(vm, "node - " + ' '.join(BOOT_FILES) + """ <<'JS'
const fs = require('node:fs');
const crypto = require('node:crypto');
for (const filename of process.argv.slice(2)) {
    const entry = fs.lstatSync(filename, { throwIfNoEntry: false });
    if (!entry) {
        console.log(filename + ' absent');
        continue;
    }
    if (!entry.isFile()) throw new Error('expected a regular boot file: ' + filename);
    const digest = crypto.createHash('sha256').update(fs.readFileSync(filename)).digest('hex');
    console.log(filename + ' ' + digest + ' ' + (entry.mode & 0o777).toString(8));
}
JS""")
    result = {}
    for line in output.splitlines():
        filename, *info = line.split()
        if info != ['absent'] and (len(info) != 2 or not re.fullmatch(r'[0-9a-f]{64}', info[0])):
            raise RuntimeError('could not read boot entry point digests')
        result[filename] = tuple(info)
    if set(result) != set(BOOT_FILES):
        raise RuntimeError('incomplete boot entry point receipt')
    return result


def verify_boot_files(vm, old, new, interrupted):
    observed = boot_files_receipt(vm)
    for filename, state in observed.items():
        acceptable = (old[filename],) if filename == interrupted or filename not in new else (old[filename], new[filename])
        if state not in acceptable:
            raise RuntimeError(f'{filename}: cut left bytes or mode outside the complete old/new versions')
    with (vm.receipts/'boot-file-receipts.jsonl').open('a') as log:
        print(json.dumps({'phase': 'disk before startup', 'interrupted': interrupted,
                          'previous': old, 'candidate': new, 'files': observed}), file=log)


def check_transfer_cut(vm, release, transfer, before):
    interrupted = TRANSFER_TARGETS[transfer]
    checked(vm, 'sync')
    old_flows = vm.flows_receipt()
    old_boot_files = boot_files_receipt(vm)
    candidate_boot_files = {
        filename: (hashlib.sha256((release/source).read_bytes()).hexdigest(), mode)
        for filename, (source, mode) in BOOT_FILES.items() if source is not None
    }
    command = f'set -e\nexport OSI_TEST_TRANSFER={transfer}\n' + PARTIAL_CURL + CANDIDATE_INSTALL
    code, receipt = vm.command(command, 2400, until=PARTIAL_DOWNLOAD)
    if code is not None:
        raise RuntimeError(f'offline installer exited {code} before the {transfer} transfer cut')
    vm.stop(cut=True)
    if receipt != (transfer.encode(),):
        raise RuntimeError('cut reached the wrong boot-file transfer')
    vm.verify_cut_disk(f'partial {transfer} transfer', old_flows, inspect=lambda guest:
        verify_boot_files(guest, old_boot_files, candidate_boot_files, interrupted))
    vm.start()
    wait_for_login(vm)
    if sql(vm, READ) != before or vm.flows_receipt() != old_flows:
        raise RuntimeError('retained payload or fixture changed after the transfer cut')
