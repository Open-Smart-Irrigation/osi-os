#!/usr/bin/env python3
"""Measure the Go and Node-RED backends on disposable Pi 5 factory media."""

import argparse
import contextlib
from datetime import datetime, timedelta, timezone
import hashlib
import json
import os
from pathlib import Path
import re
import select
import shlex
import socket
import struct
import subprocess
import sys
import tarfile
import time
import urllib.error
import urllib.request
import uuid


HERE = Path(__file__).resolve().parent
ROOT = HERE.parents[1]
sys.path.insert(0, str(ROOT / 'tools' / 'raspi5'))
from radio_suite import LocalOnly  # noqa: E402
from suite_vm import Guest, external_path, reap  # noqa: E402
from vectors import measure_go_vectors, measure_node_vectors, stage_vectors


DB = '/data/db/farming.db'
RADIO_DB = '/srv/chirpstack/chirpstack.sqlite'
SCENARIO = ROOT / 'edge/harness/scenarios/060-kiwi-ingest.json'
PACKAGE = ROOT / 'edge/package/files'
MQTT = HERE / 'mqtt.cjs'
CLOUD_IMAGE = 'docker.io/library/eclipse-mosquitto@sha256:09b62ff32c2e7b64d4b431b9a89236073289b68db273de2b089edeb9b0d92b5c'
CLOUD_GUEST = '192.0.2.100'
GUEST = '192.0.2.15'
LOGIN = {'username': 'farmer', 'password': 'synthetic-pass-1'}
VALVES = [f'A8404100000000{i:02X}' for i in range(16, 21)]
OPENER = urllib.request.build_opener(urllib.request.ProxyHandler({}), LocalOnly())


def sha256(path):
    with path.open('rb') as f:
        return hashlib.file_digest(f, 'sha256').hexdigest()


def candidate(directory, requested=None):
    eligible = []
    for sums in directory.glob('*/SHA256SUMS'):
        if sums.parent.name.startswith('fixture-tree-'):
            continue
        for line in sums.read_text().splitlines():
            match = re.fullmatch(r'([0-9a-fA-F]{64})\s+\*?([^/]+-rpi5-factory\.img\.gz)', line)
            if match:
                image = sums.parent / match[2]
                if image.is_file() and (requested is None or image == requested):
                    emulator_only = 'EMULATOR-ONLY' in str(image).upper()
                    eligible.append((not emulator_only, image.stat().st_mtime_ns, image, match[1].lower()))
    if not eligible:
        raise ValueError(f'no Pi 5 factory archive with SHA256SUMS entry for {requested or directory}')
    _, _, image, expected = max(eligible)
    if sha256(image) != expected:
        raise ValueError(f'checksum mismatch for {image}')
    return image, expected


def fixture():
    steps = {step['id']: step for step in json.loads(SCENARIO.read_text())['steps']}
    uplinks = steps['uplinks']['uplinks'][:500]
    if len(uplinks) != 500:
        raise ValueError('the KIWI scenario has fewer than 500 uplinks')
    return steps['claim-sensor']['sql'], uplinks


def port():
    with socket.socket() as sock:
        sock.bind(('127.0.0.1', 0))
        return sock.getsockname()[1]


class Pi(Guest):
    boot_media_script = '''set -e
media=$(awk '$1 == "/dev/mmcblk0p1" && $3 == "vfat" {print $2; exit}' /proc/mounts)
if [ -z "$media" ]; then
    media=/root/osi-emulator-media
    mkdir -p "$media"
    mount -t vfat -o ro /dev/mmcblk0p1 "$media"
    trap 'umount "$media"; rmdir "$media"' EXIT
fi
'''

    def __init__(self, work, image, qemu, cloud_port=None):
        super().__init__(work, image, qemu, 4, direct_io=True)
        self.mqtt_port = port()
        self.cloud_port = cloud_port

    def stage(self, files):
        disk = self.work / 'sd.img'
        with disk.open('rb') as card:
            boot_offset = struct.unpack_from('<I', card.read(512), 454)[0] * 512
        for source, filename in files:
            subprocess.run(['mcopy', '-i', f'{disk}@@{boot_offset}', source, '::' + filename], check=True)

    def stage_bundle(self, binary):
        self.stage([
            (binary, 'osi-edge'),
            (PACKAGE / 'etc/init.d/osi-edge', 'edge-init'),
            (PACKAGE / 'usr/sbin/osi-backend', 'osi-backend'),
        ])

    def start(self):
        # Reuse Guest's Pi command, serial shell and power-cut cleanup. The acceptance
        # bridge cannot accept extra forwards, so use a restricted ARM slirp backend.
        if self.process is not None:
            raise RuntimeError('previous guest has not been reaped')
        self.boots += 1
        self.buf = b''
        cmdline = (self.work / 'cmdline.txt').read_text().strip() + ' ' + self.console_args
        args = self.qemu_args(-1, 'if=sd,format=raw,file=sd.img,cache=none', cmdline, False)
        args[args.index('-nic') + 1] = ','.join([
            'user', 'restrict=on', 'net=192.0.2.0/24',
            f'hostfwd=tcp:127.0.0.1:{self.port}-{GUEST}:1880',
            f'hostfwd=tcp:127.0.0.1:{self.mqtt_port}-{GUEST}:1883',
        ])
        if self.cloud_port is not None:
            args[args.index('-nic') + 1] += (
                f',guestfwd=tcp:{CLOUD_GUEST}:1883-cmd:socat STDIO TCP4:127.0.0.1:{self.cloud_port}')
        self.radio, air = socket.socketpair()
        with air, self.stderr(f'qemu-{self.boots}.stderr', 'wb') as stderr:
            args.extend(['-chardev', f'socket,id=wm1302-air,fd={air.fileno()},server=off'])
            self.started = time.monotonic()
            self.process = subprocess.Popen(args, cwd=self.work, pass_fds=(air.fileno(),),
                                            stdin=subprocess.PIPE, stdout=subprocess.PIPE, stderr=stderr)
        self.expect(b'Please press Enter to activate this console', 180)
        self.send(b'\n')
        self.expect(b':~#', 40)
        self.send(b'stty -echo; dmesg -n 1\n')
        self.shell('''for i in $(seq 1 60); do
    ip addr add 192.0.2.15/24 dev br-lan 2>/dev/null || ip -4 addr show | grep -q 192.0.2.15 ||
      ip addr add 192.0.2.15/24 dev eth0 2>/dev/null || { sleep 1; continue; }
    exit 0
done
exit 1''')

    def shell(self, script, timeout=90):
        status, output = self.command(script, timeout)
        if status:
            raise RuntimeError(f'guest command exit {status}: {output or script.splitlines()[0]}')
        return output

    def sql(self, query, database=DB, *, write=False):
        args = ['sqlite3', '-batch', '-bail', '-cmd', '.timeout 5000']
        if not write:
            args.append('-readonly')
        return self.shell(shlex.join([*args, database, query]) + ' 2>&1')

    def http(self, path, body=None, token=None, timeout=5):
        req = urllib.request.Request(self.url + path, data=None if body is None else json.dumps(body).encode())
        req.add_header('Content-Type', 'application/json')
        if token:
            req.add_header('Authorization', f'Bearer {token}')
        try:
            with OPENER.open(req, timeout=timeout) as response:
                return response.status, response.read(), response.headers.get('Content-Type', '')
        except urllib.error.HTTPError as error:
            return error.code, error.read(), error.headers.get('Content-Type', '')

    def wait_http(self, budget=800):
        deadline = time.monotonic() + budget
        while time.monotonic() < deadline:
            try:
                status, _, _ = self.http('/api/me', timeout=2)
                if status == 401:
                    return round(time.monotonic() - self.started, 3)
            except (OSError, urllib.error.URLError):
                pass
            time.sleep(0.25)
        raise TimeoutError('HTTP readiness probe did not return 401')

    def install(self):
        self.shell(self.boot_media_script + '''cp "$media/osi-edge" /usr/bin/osi-edge
cp "$media/edge-init" /etc/init.d/osi-edge
cp "$media/osi-backend" /usr/sbin/osi-backend
chmod 755 /usr/bin/osi-edge /etc/init.d/osi-edge /usr/sbin/osi-backend
sha256sum /usr/bin/osi-edge /etc/init.d/osi-edge /usr/sbin/osi-backend
''')

    def owners(self):
        return self.shell(r'''netstat -lntp 2>/dev/null | awk '$4 ~ /:1880$/ && $6 == "LISTEN" {print $7}' | sort -u''').splitlines()

    def rss(self, backend):
        owners = self.owners()
        if len(owners) != 1 or not re.fullmatch(r'\d+/[^ ]+', owners[0]):
            raise RuntimeError(f'expected one owner on :1880, got {owners!r}')
        pid = owners[0].split('/')[0]
        cmd, name = self.shell(f"tr '\\000' ' ' </proc/{pid}/cmdline; echo; cat /proc/{pid}/comm").splitlines()
        if (backend == 'edge' and name != 'osi-edge') or (backend == 'node-red' and 'node-red' not in cmd + name):
            raise RuntimeError(f'unexpected :1880 process for {backend}: {name}')
        values = self.shell(f"awk '/^Vm(RSS|HWM):/ {{ print $1, $2 }}' /proc/{pid}/status")
        memory = {key.rstrip(':'): int(value) for key, value in map(str.split, values.splitlines())}
        return {'pid': int(pid), 'listener': owners[0], 'rss_kib': memory['VmRSS'], 'hwm_kib': memory['VmHWM']}

    def smoke(self, backend):
        proc = self.rss(backend)
        # curl follows the stock /gui -> /gui/ redirect on the guest loopback.
        gui = self.shell("curl -sSL --max-time 5 -o /dev/null -w '%{http_code}|%{content_type}' http://127.0.0.1:1880/gui")
        status, data, _ = self.http('/auth/login', LOGIN, timeout=15)
        return {'gui': gui, 'login': status, 'login_has_token': status == 200 and bool(json.loads(data).get('token')),
                **proc}

    def user(self):
        status, _, _ = self.http('/auth/register', LOGIN, timeout=30)
        if status not in (200, 201):
            raise RuntimeError(f'fresh factory registration returned {status}')
        return self.token()

    def token(self):
        status, data, _ = self.http('/auth/login', LOGIN, timeout=15)
        if status != 200:
            raise RuntimeError(f'login returned {status}')
        return json.loads(data)['token']

    def rows(self):
        return int(self.sql('SELECT count(*) FROM device_data'))

    def duplicate_keys(self):
        return int(self.sql('''SELECT count(*) FROM (SELECT deveui,uplink_key FROM device_data
            WHERE uplink_key IS NOT NULL GROUP BY deveui,uplink_key HAVING count(*) > 1)'''))

    def queue(self, valve):
        found = self.sql("SELECT name FROM sqlite_master WHERE type='table' AND name='device_queue_item'", RADIO_DB)
        if not found:
            raise RuntimeError('ChirpStack device_queue_item table missing')
        return self.sql(f"SELECT id FROM device_queue_item WHERE upper(hex(dev_eui))='{valve}' ORDER BY id", RADIO_DB).splitlines()


def wait_for(predicate, seconds):
    deadline = time.monotonic() + seconds
    while time.monotonic() < deadline:
        result = predicate()
        if result:
            return result
        time.sleep(0.25)
    raise TimeoutError(f'condition not met after {seconds} s')


def settle(vm, quiet=5):
    deadline = time.monotonic() + 90
    count = vm.rows()
    stable_since = time.monotonic()
    while time.monotonic() < deadline:
        time.sleep(0.5)
        observed = vm.rows()
        if observed != count:
            count = observed
            stable_since = time.monotonic()
        elif time.monotonic() - stable_since >= quiet:
            return count
    raise TimeoutError('device_data writes did not settle')


def publish(vm, fixture_path):
    result = subprocess.run(['node', MQTT, 'publish', str(vm.mqtt_port), fixture_path],
                            capture_output=True, text=True, timeout=90, check=True)
    return json.loads(result.stdout)['acknowledged']


class Cloud:
    def __init__(self, directory):
        self.log = (directory / 'cloud.stderr').open('w')
        self.process = subprocess.Popen(['node', MQTT, 'cloud', directory], stdin=subprocess.PIPE,
                                        stdout=subprocess.PIPE, text=True, stderr=self.log)
        try:
            self.port = int(self.read()['url'].rsplit(':', 1)[1])
        except BaseException:
            self.close()
            raise

    def read(self):
        if not select.select([self.process.stdout], [], [], 75)[0]:
            raise TimeoutError('cloud recorder timed out')
        response = self.process.stdout.readline()
        if not response:
            raise RuntimeError('cloud recorder exited; see cloud.stderr')
        data = json.loads(response)
        if 'error' in data:
            raise RuntimeError(data['error'])
        return data

    def control(self, action):
        self.process.stdin.write(action + '\n')
        self.process.stdin.flush()
        return self.read()['packets']

    def close(self):
        self.process.stdin.close()
        try:
            self.process.wait(timeout=65)
        except subprocess.TimeoutExpired:
            reap(self.process)
        self.process.stdout.close()
        self.log.close()
        if self.process.returncode:
            raise RuntimeError('cloud recorder cleanup failed; see cloud.stderr')


def switch(vm, backend):
    log = vm.shell(f'''log=$(mktemp /run/osi-switch.XXXXXX) || exit 1
trap 'rm -f "$log"' EXIT
osi-backend use {backend} >"$log" 2>&1 &
selector=$!
overlap=0
while kill -0 "$selector" 2>/dev/null; do
    owners=$(netstat -lntp 2>/dev/null | awk '$4 ~ /:1880$/ && $6 == "LISTEN" {{print $7}}' | sort -u | wc -l)
    if [ "$owners" -gt 1 ]; then overlap=1; fi
    sleep 0.2
done
wait "$selector"
rc=$?
cat "$log"
if [ "$overlap" -ne 0 ]; then echo 'multiple listener owners during switch'; exit 1; fi
osi-backend status
exit "$rc"
''', 100)
    vm.wait_http()
    if log.splitlines()[-2:] != [backend, f'running: {backend}']:
        raise RuntimeError(f'unexpected switch receipt: {log}')
    return log


def measure(vm, backend, input_path, *, idle):
    before = vm.rows()
    start = time.monotonic()
    count = publish(vm, input_path)
    rows = settle(vm) - before
    return {'published_qos1': count, 'rows_before': before, 'rows_written': rows,
            'elapsed_seconds_including_settle': round(time.monotonic() - start, 3),
            'idle': idle, 'after_load': vm.rss(backend), 'duplicate_keys': vm.duplicate_keys()}


def migration_bundle(path):
    with tarfile.open(path, 'w:gz') as archive:
        for directory, glob in [('lib/osi-migrate', '*.js'), ('database/migrations/ordered', '*')]:
            for file in sorted((ROOT / directory).glob(glob)):
                if file.is_file():
                    archive.add(file, arcname=file.relative_to(ROOT))
        for name in [
            'scripts/migrate-cli.js', 'scripts/verify-head-cli.js',
            'scripts/reconcile-ledger-numbering.js', 'scripts/semantic-schema-compare.js',
            'scripts/baseline-existing-db.js',
        ]:
            archive.add(ROOT / name, arcname=name)


def schema_head(vm, evidence, lane):
    query = "SELECT max(version) FROM schema_migrations WHERE status='applied'"
    head = int(vm.sql(query))
    evidence.add(f'{lane}-factory-schema', schema_head=head)
    if head < 84:
        # Fresh candidate images can lag the spike corpus. Apply the normal
        # ordered migrations to the image-owned DB with the writer stopped.
        details = vm.shell(vm.boot_media_script + r'''root=/root/osi-emulator-migrate
mkdir -p "$root"
tar -xzf "$media/migrate.tgz" -C "$root"
cd "$root"
/etc/init.d/node-red stop
for i in $(seq 1 30); do
    if ! pgrep -f '/usr/lib/node/node-red/red.js' >/dev/null; then break; fi
    sleep 1
done
if pgrep -f '/usr/lib/node/node-red/red.js'; then exit 1; fi
db=/data/db/farming.db
schedule_at_81=$(sqlite3 -readonly -batch -bail "$db" "SELECT count(*) FROM schema_migrations WHERE version=81 AND name='0081__schedule_insert_outbox_trigger.sql'")
if [ "$schedule_at_81" = 1 ]; then
    node scripts/reconcile-ledger-numbering.js "$db" --report 2>&1
    node scripts/reconcile-ledger-numbering.js "$db" --apply --backup-dir /data/backups/migrate 2>&1
fi
node scripts/migrate-cli.js /data/db/farming.db --backup-dir /data/backups/migrate 2>&1
node scripts/verify-head-cli.js /data/db/farming.db 2>&1
/etc/init.d/node-red start
''', 300)
        evidence.add(f'{lane}-migration', original_head=head, output=details)
        vm.wait_http()
        head = int(vm.sql(query))
    if head != 84:
        raise RuntimeError(f'expected migration head 84, got {head}')
    return head


def node_sqlite(vm):
    return vm.shell(r'''node - <<'JS' 2>&1
const sqlite = require('/usr/lib/node/node-red/node_modules/node-red-node-sqlite/node_modules/sqlite3');
const db = new sqlite.Database('/data/db/farming.db', sqlite.OPEN_READONLY);
db.get('SELECT sqlite_version() AS version', (err, row) => {
  if (err) throw err;
  console.log(row.version);
  db.close();
});
JS''')


def provision_radios(vm, token):
    for valve in VALVES:
        response, data, _ = vm.http('/api/devices', {
            'deveui': valve, 'type_id': 'STREGA_VALVE', 'name': f'Emulated valve {valve[-2:]}',
            'strega_generation': 'GEN1', 'appkey': os.urandom(16).hex(),
        }, token, timeout=45)
        if response not in (200, 201):
            raise RuntimeError(f'factory Node-RED device registration returned {response}: {data.decode(errors="replace")}')
        if vm.queue(valve):
            raise RuntimeError('synthetic device queue should start empty')


def open_valve(vm, token, valve):
    return vm.http(f'/api/valve/{valve}', {'action': 'OPEN_FOR_DURATION', 'duration_minutes': 2}, token, timeout=30)


def install_guest_radio_settings(vm):
    # The spike package does not yet load these two settings. Keep the measured
    # install intact and add the missing procd environment on this VM only.
    vm.shell(r'''set -e
init=/etc/init.d/osi-edge
config=/srv/node-red/.chirpstack.env
grep -q '^CHIRPSTACK_API_KEY=.' "$config"
grep -q '^CHIRPSTACK_API_URL=.' "$config"
cp "$init" "$init.package"
awk '
  /procd_close_instance/ {
    print "    procd_append_param env CHIRPSTACK_API_URL=\"$(kiwi_chirpstack_setting chirpstack_api_url CHIRPSTACK_API_URL)\" CHIRPSTACK_API_KEY=\"$(kiwi_chirpstack_setting chirpstack_api_key CHIRPSTACK_API_KEY)\""
  }
  { print }
' "$init.package" >"$init"
sh -n "$init"
/etc/init.d/osi-edge restart
''')
    vm.wait_http()


def offset_uplinks(uplinks, index):
    # Use the same decoded readings with disjoint uplink identities per cut.
    result = json.loads(json.dumps(uplinks))
    ids = {}
    for message in result:
        payload = message['payload']
        old_id = payload['deduplicationId']
        ids.setdefault(old_id, str(uuid.uuid5(uuid.NAMESPACE_OID, f'{index}/{old_id}')))
        payload['deduplicationId'] = ids[old_id]
        payload['fCnt'] += index * 1000
        stamp = datetime.fromisoformat(payload['time']) + timedelta(milliseconds=index)
        payload['time'] = stamp.isoformat(timespec='milliseconds').replace('+00:00', 'Z')
    return result


def cut(vm, num, uplinks, record):
    record['seq'] = num
    valve = VALVES[num - 1]
    source = vm.work / f'cut-{num}-uplinks.json'
    source.write_text(json.dumps(offset_uplinks(uplinks, num)))
    token = vm.token()
    before = vm.rows()
    if vm.queue(valve):
        raise RuntimeError('synthetic valve queue already contains an item')
    with (vm.work / f'cut-{num}-publish.log').open('w') as out:
        pressure = subprocess.Popen(['node', MQTT, 'publish', str(vm.mqtt_port), source, 'repeat'],
                                    stdout=out, stderr=out)
        try:
            record['rows_at_ingest_start'] = wait_for(lambda: (rows := vm.rows()) > before and rows, 45)
            status, data, _ = open_valve(vm, token, valve)
            record['open_http'] = status
            record['open_response'] = json.loads(data)
            record['queue_at_cut'] = vm.queue(valve)
            if status != 200 or len(record['queue_at_cut']) != 1:
                raise RuntimeError(f'timed open failed to queue exactly one item (HTTP {status})')
            record['rows_at_cut'] = vm.rows()
            if pressure.poll() is not None:
                raise RuntimeError('MQTT load was no longer running at the cut')
            record['publisher_active_at_cut'] = True
            vm.stop(cut=True)
            record['qemu_exit'] = int((vm.work / f'qemu-{vm.boots}.exit').read_text())
        finally:
            reap(pressure)
    vm.start()
    record['back_serving_seconds'] = vm.wait_http()
    record['edge_owner'] = vm.rss('edge')['listener']
    record['integrity_check'] = vm.sql('PRAGMA integrity_check')
    record['queue_after_reboot'] = vm.queue(valve)
    record['rows_after_reboot'] = vm.rows()
    record['redelivery_qos1'] = publish(vm, source)
    record['rows_after_redelivery'] = settle(vm)
    record['duplicate_keys'] = vm.duplicate_keys()
    record['queue_after_redelivery'] = vm.queue(valve)
    record['pass'] = (
        record['qemu_exit'] == -9 and record['back_serving_seconds'] <= 60
        and record['integrity_check'] == 'ok' and record['duplicate_keys'] == 0
        and record['queue_at_cut'] == record['queue_after_reboot'] == record['queue_after_redelivery']
    )


def cloud_check(vm, broker, uplinks, record):
    source = vm.work / 'cloud-probe.json'
    source.write_text(json.dumps(offset_uplinks(uplinks[:1], 100)))
    vm.shell(f'''set -e
uci set osi-server.cloud.mqtt_broker_url='mqtt://{CLOUD_GUEST}:1883'
uci commit osi-server
/etc/init.d/osi-edge restart
''')
    vm.wait_http()
    try:
        broker.control('connected')
        broker.control('hold-puback')
        record['published_qos1'] = publish(vm, source)
        packets = broker.control('puback-held')
        held = next(p for p in reversed(packets) if p.get('forwarded') is False)
        original = next(p for p in packets if p['cmd'] == 'publish' and p.get('messageId') == held['messageId'])
        record['first_publish'] = {k: original[k] for k in ('topic', 'qos', 'messageId', 'dup')}
        if original['qos'] != 1 or not original['topic'].endswith('/telemetry'):
            raise RuntimeError('the held PUBACK did not belong to QoS 1 telemetry')
        record['held_puback'] = held
        broker.control('stop')
        broker.control('start')
        packets = wait_for(lambda: retry_receipt(broker, original), 30)
        record.update(packets)
        record['pass'] = True
    finally:
        (vm.work / 'cloud-packets.json').write_text(json.dumps(broker.control('packets'), indent=2) + '\n')


def retry_receipt(broker, original):
    packets = broker.control('packets')
    connects = [p for p in packets if p['cmd'] == 'connect']
    if len(connects) < 2 or any(p['cleanStart'] or p['protocolVersion'] != 5 for p in connects):
        return None
    reconnect = packets[packets.index(connects[-1]) + 1:]
    # Paho can retry the same in-flight payload with a fresh packet ID after the
    # broker reports no session. Record the ID/DUP bits and require the new ACK.
    for offset, packet in enumerate(reconnect):
        if (packet['cmd'] == 'publish' and packet['qos'] == 1 and packet['topic'] == original['topic']
                and packet['payload'] == original['payload']):
            ack = next((p for p in reconnect[offset + 1:] if p['cmd'] == 'puback'
                        and p['messageId'] == packet['messageId']), None)
            if ack:
                return {'connects': connects, 'retry_puback': ack,
                        'connack': next(p for p in reconnect if p['cmd'] == 'connack'),
                        'retry_publish': {k: packet[k] for k in ('topic', 'qos', 'messageId', 'dup')}}
    return None


class Evidence:
    def __init__(self, directory):
        self.path = directory / 'results.jsonl'

    def add(self, name, **fields):
        result = {'phase': name, 'utc': datetime.now(timezone.utc).isoformat(), **fields}
        with self.path.open('a') as f:
            print(json.dumps(result), file=f)
        print(json.dumps(result), flush=True)

    def attempt(self, name, operation, *args, **kwargs):
        try:
            result = operation(*args, **kwargs)
        except Exception as error:
            self.add(name, error=repr(error))
            return None
        self.add(name, **result)
        return result


def verify_switch(vm, backend, evidence):
    evidence.add(f'switch-{backend}', output=switch(vm, backend))
    return evidence.attempt(f'{backend}-http', vm.smoke, backend)


def pressure_checks(vm, broker, provisioned, uplinks, evidence):
    def radio_settings():
        pid = vm.rss('edge')['pid']
        configured = vm.shell(f"tr '\\000' '\\n' </proc/{pid}/environ | sed -n 's/^\\(CHIRPSTACK_API_[A-Z]*\\)=.*/\\1/p'")
        if set(configured.splitlines()) == {'CHIRPSTACK_API_URL', 'CHIRPSTACK_API_KEY'}:
            return {'factory_package_settings': True}
        status, raw, _ = open_valve(vm, vm.token(), VALVES[0])
        evidence.add('stock-package-valve-probe', http=status, response=raw.decode(errors='replace'))
        if vm.queue(VALVES[0]):
            raise RuntimeError('probe created a queue item; use fresh valves for cut tests')
        install_guest_radio_settings(vm)
        return {'factory_package_settings': False, 'guest_only_settings_added': True}

    cut_results = []
    if provisioned and evidence.attempt('radio-settings', radio_settings) is not None:
        for seq in range(1, 6):
            details = {}
            try:
                cut(vm, seq, uplinks, details)
            except Exception as error:
                details.update(error=repr(error), pass_=False)
            evidence.add('power-cut', **details)
            cut_results.append(details.get('pass', False))
            if vm.process is None or vm.process.poll() is not None:
                break
    cloud_result = {}
    if broker is not None:
        try:
            cloud_check(vm, broker, uplinks, cloud_result)
        except Exception as error:
            cloud_result['error'] = repr(error)
    else:
        cloud_result['error'] = 'host broker was unavailable'
    evidence.add('cloud-reconnect', **cloud_result)
    return cut_results == [True] * 5 and cloud_result.get('pass') is True


def edge_lane(args, image, claim, uplinks, fixture_path, evidence, broker, migrations):
    vm = Pi(args.run_dir / 'edge', image, args.qemu, broker.port if broker else None)
    try:
        vm.stage_bundle(args.binary)
        vm.stage([(migrations, 'migrate.tgz')])
        vm.start()
        ready = vm.wait_http()
        evidence.add('edge-factory', schema_head=schema_head(vm, evidence, 'edge'), uptime_to_http_seconds=ready)
        token = vm.user()
        vm.sql(claim, write=True)
        provisioned = evidence.attempt('radio-fixture', lambda: (provision_radios(vm, token) or {'devices': len(VALVES)}))
        installed = vm.install()
        if installed.split()[0] != sha256(args.binary):
            raise RuntimeError('installed arm64 executable checksum mismatch')
        evidence.add('install', sha256sums=installed)
        edge_smoke = verify_switch(vm, 'edge', evidence)
        version = vm.shell("logread | sed -n 's/.*SQLite version \\([0-9.]*\\).*/\\1/p' | tail -n 1")
        evidence.add('edge-sqlite', version=version)
        results = evidence.attempt('edge-load', measure, vm, 'edge', fixture_path, idle=vm.rss('edge'))
        failure_drills = pressure_checks(vm, broker, provisioned, uplinks, evidence)
        rollback = verify_switch(vm, 'node-red', evidence)
        return results, (failure_drills and bool(version) and http_pass(edge_smoke) and http_pass(rollback))
    finally:
        vm.stop()


def http_pass(result):
    return bool(result and result['gui'].startswith('200|text/html') and result['login_has_token'])


def node_red_lane(args, image, claim, fixture_path, evidence, migrations, vectors):
    vm = Pi(args.run_dir / 'node-red', image, args.qemu)
    try:
        media = [(migrations, 'migrate.tgz'), (vectors, 'vectors.tgz')]
        if args.engine_test:
            media.append((args.engine_test, 'store.test'))
        vm.stage(media)
        vm.start()
        # Report vectors even when HTTP or migration readiness fails.
        node = evidence.attempt('sqlite-engine-node', measure_node_vectors, vm, args.run_dir)
        if node and args.engine_test:
            evidence.attempt('sqlite-engine-go', measure_go_vectors, vm, args.run_dir)
        ready = vm.wait_http()
        evidence.add('node-red-factory', schema_head=schema_head(vm, evidence, 'node-red'), uptime_to_http_seconds=ready)
        vm.user()
        vm.sql(claim, write=True)
        version = evidence.attempt('node-red-sqlite', lambda: {'version': node_sqlite(vm)})
        smoke = evidence.attempt('node-red-http', vm.smoke, 'node-red')
        results = evidence.attempt('node-red-load', measure, vm, 'node-red', fixture_path, idle=vm.rss('node-red'))
        return results, bool(version and http_pass(smoke))
    finally:
        vm.stop()


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('--run-dir', type=Path, required=True, help='existing external evidence directory')
    parser.add_argument('--binary', type=Path, required=True, help='stripped CGO-off Linux arm64 binary')
    parser.add_argument('--qemu', type=Path, required=True, help='Pi 5 QEMU build with dtmerge and rpi5-bl31.bin beside it')
    parser.add_argument('--candidates', type=Path, required=True, help='directory containing candidate SHA256SUMS files')
    parser.add_argument('--candidate', type=Path, help='pin a checksum-listed factory archive')
    parser.add_argument('--engine-test', type=Path, help='optional arm64 internal/store test binary built with -trimpath')
    parser.add_argument('--dry-run', action='store_true', help='verify inputs and build disposable media without booting')
    args = parser.parse_args()
    args.run_dir = external_path(args.run_dir, off_tmp=True)
    args.binary = external_path(args.binary, off_tmp=True)
    args.qemu = external_path(args.qemu, off_tmp=True)
    if args.engine_test:
        args.engine_test = external_path(args.engine_test, off_tmp=True)
    requested = external_path(args.candidate, off_tmp=True) if args.candidate else None
    image, image_sha = candidate(external_path(args.candidates, off_tmp=True), requested)
    claim, uplinks = fixture()
    with args.binary.open('rb') as executable:
        header = executable.read(20)
    if header[:6] != b'\x7fELF\x02\x01' or struct.unpack_from('<H', header, 18)[0] != 183:
        parser.error('the supplied binary is not a little-endian ARM64 ELF')
    if not args.dry_run:
        unit = os.getenv('OSI_HEAVY_UNIT')
        if (not unit or f'/{unit}.scope' not in Path('/proc/self/cgroup').read_text()
                or not os.getenv('OSI_HEAVY_HOLDER', '').startswith('edge-emulator-g1:')):
            parser.error('boot requires the contained edge-emulator-g1 osi-heavy slot')
    evidence = Evidence(args.run_dir)
    evidence.add('inputs', image=str(image), image_sha256=image_sha, qemu=str(args.qemu),
                 qemu_version=subprocess.check_output([args.qemu, '--version'], text=True).splitlines()[0],
                 qemu_sha256=sha256(args.qemu), bl31_sha256=sha256(args.qemu.with_name('rpi5-bl31.bin')),
                 binary_bytes=args.binary.stat().st_size, binary_sha256=sha256(args.binary), ram_gib=4,
                 uplinks=len(uplinks))
    migrations = args.run_dir / 'migrate.tgz'
    migration_bundle(migrations)
    vectors = args.run_dir / 'vectors.tgz'
    stage_vectors(vectors)
    if args.dry_run:
        vm = Pi(args.run_dir / 'dry-run', image, args.qemu)
        vm.stage_bundle(args.binary)
        vm.stage([(migrations, 'migrate.tgz'), (vectors, 'vectors.tgz')])
        if args.engine_test:
            vm.stage([(args.engine_test, 'store.test')])
        evidence.add('dry-run', staged=True)
        return 0
    fixture_path = args.run_dir / 'kiwi-500.json'
    fixture_path.write_text(json.dumps(uplinks))
    baseline = edge = None
    baseline_ok = edge_ok = False
    try:
        baseline, baseline_ok = node_red_lane(args, image, claim, fixture_path, evidence, migrations, vectors)
    except Exception as error:
        evidence.add('node-red-lane', error=repr(error))
    with contextlib.ExitStack() as cleanup:
        broker = None
        try:
            # The existing cassette recorder may pull a missing image. Verify its
            # exact digest is already present so the emulator only uses local inputs.
            subprocess.run(['podman', 'image', 'exists', CLOUD_IMAGE], check=True, timeout=30)
            broker = Cloud(args.run_dir)
            cleanup.callback(broker.close)
        except Exception as error:
            evidence.add('cloud-start', error=repr(error))
        try:
            edge, edge_ok = edge_lane(args, image, claim, uplinks, fixture_path, evidence, broker, migrations)
        except Exception as error:
            evidence.add('edge-lane', error=repr(error))
    parity = bool(baseline and edge and baseline['published_qos1'] == edge['published_qos1'] == 500
                  and baseline['rows_written'] == edge['rows_written'] > 0
                  and baseline['duplicate_keys'] == edge['duplicate_keys'] == 0)
    evidence.add('summary', load_rows_match=parity, node_red_pass=baseline_ok, edge_pass=edge_ok)
    return 0 if parity and baseline_ok and edge_ok else 1


if __name__ == '__main__':
    sys.exit(main())
