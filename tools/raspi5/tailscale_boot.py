"""Tailscale boot cases: a stalled cleanup is cut short and the service starts at S99.

The tailscale 1.80.3-r1 package init runs `tailscaled --cleanup` before the
daemon, with no time limit, at S80. The OSI copy cuts that cleanup short
after OSI_CLEANUP_LIMIT seconds and starts the service at S99.

A stand-in for tailscaled makes the cleanup block in one process, the way a
hung cleanup does, and runs the real binary for everything else. Evidence
comes from the guest's persistent syslog, read after a marker written before
the reboot.
"""
import re
import secrets
import subprocess
import time
from pathlib import Path

from suite_vm import SLOW_BOOT_SECONDS
from upgrade_suite import CANDIDATE_INSTALL, checked

INIT = Path('conf/full_raspberrypi_bcm27xx_bcm2712/files/etc/init.d/tailscale')
INSTALLED_CASE = 'Tailscale init installed by the deploy'
STALL_CASE = 'Tailscale cleanup cut short'
NORMAL_CASE = 'Tailscale boot without a stall'
REFUSAL_CASE = 'Tailscale init left alone'
FALLBACK_CASE = 'Tailscale stall before the fix'
LOCK_CASE = 'Tailscale restart after a surviving cleanup'
BOOTSTRAP_CASE = 'Stamped osi-bootstrap before tailscale'
CASES = (INSTALLED_CASE, STALL_CASE, NORMAL_CASE, LOCK_CASE, REFUSAL_CASE, FALLBACK_CASE, BOOTSTRAP_CASE)

# The one line a technician on the LAN runs over SSH; the runbook carries it
# under "Boot stops at the tailscale cleanup". The bracket keeps the pattern
# from matching the shell that runs the line.
TECHNICIAN_COMMAND = "kill -9 $(pgrep -f 'tailscaled --cleanu[p]')"
STALLED_CLEANUP = "pgrep -f 'tailscaled --cleanu[p]'"
# The same lookup through ps, for an image without pgrep. Each lookup runs
# in a shell whose own command line carries the pattern with its bracket.
PS_LOOKUP = "ps w | awk '/[t]ailscaled --cleanu[p]/ {print $1}'"
ALTERNATE_COMMAND = 'kill -9 $(' + PS_LOOKUP + ')'
# The line of the on-site instructions for a gateway held at the cleanup. The
# fallback case runs it too, in a second round, and times the recovery the
# way that document does.
ONSITE_COMMAND = "kill -9 $(ps w | grep '[t]ailscaled --cleanup' | awk '{print $1}')"
ONSITE_LOOKUP = "ps w | grep '[t]ailscaled --cleanup' | awk '{print $1}'"
# What the on-site document checks after the kill, in its order.
MILESTONES = ("echo \"daemon=$(pidof tailscaled.real) chirpstack=$(pidof chirpstack) \""
              "\"node=$(ps w | grep -q '[n]ode-red' && echo up) \""
              "\"gui=$(wget -q -T 2 -O /dev/null http://127.0.0.1:1880/gui/ && echo up)\"")
HANG_AGE = ("p=$(pgrep -f 'tailscaled --cleanu[p]'); "
            "echo $(( $(cut -d. -f1 /proc/uptime) - $(cut -d' ' -f22 /proc/$p/stat) / 100 ))")
# What must be absent while the boot is held, and how long the cleanup has run.
# Over SSH the whole line is the command line of a `sh -c`, which `ps w`
# lists: no word here may match a pattern it greps for.
HELD_STATE = ("pidof chirpstack; ps w | grep -q '[n]ode-red' && echo nodered-up; "
              "wget -q -T 2 -O /dev/null http://127.0.0.1:1880/gui/ && echo gui-up; echo age=$(" + HANG_AGE + ")")

# One process, blocked in open(2) on a FIFO that no writer opens.
STALL_WRAPPER = """#!/bin/sh
# Test stand-in: the cleanup blocks; everything else runs the real binary.
if [ "$1" = "--cleanup" ]; then
    logger -t osi-test-cleanup "cleanup stall started"
    mkfifo /tmp/osi-cleanup-stall.fifo
    exec 3</tmp/osi-cleanup-stall.fifo
    exit 0
fi
exec /usr/sbin/tailscaled.real "$@"
"""

# procd prints this as soon as it reaches its init state, while the rc.d
# scripts still run: a boot held at the cleanup shows it too (the on-site
# instructions saw the console about 8 s after power-on). It is never
# evidence that the boot got past the cleanup.
# A cleanup that outlives its kill: it leaves a child that keeps every fd it
# inherited, as a process stuck past SIGKILL keeps its own, and then blocks.
SURVIVOR_WRAPPER = """#!/bin/sh
# Test stand-in: the cleanup leaves a child holding its fds, then blocks.
if [ "$1" = "--cleanup" ]; then
    logger -t osi-test-cleanup "surviving cleanup started"
    sleep 100000 &
    mkfifo /tmp/osi-cleanup-stall.fifo 2>/dev/null
    exec 3</tmp/osi-cleanup-stall.fifo
    exit 0
fi
exec /usr/sbin/tailscaled.real "$@"
"""
SURVIVORS = "pgrep -f 'sleep 10000[0]'"
# One restart, run in the background so a blocked one is seen and ended: it
# prints "done <seconds>" or "blocked <seconds>".
RESTART = """/etc/init.d/tailscale restart >/tmp/osi-test-restart.log 2>&1 &
p=$!
i=0
while kill -0 "$p" 2>/dev/null && [ "$i" -lt RESTART_LIMIT ]; do sleep 1; i=$((i + 1)); done
if kill -0 "$p" 2>/dev/null; then echo "blocked $i"; kill "$p"; else echo "done $i"; fi
"""
RESTART_LIMIT = 90
# How many surviving children hold the procd lock of the service.
LOCK_HOLDERS = """n=0
for p in $(""" + SURVIVORS + """); do
    ls -l /proc/$p/fd 2>/dev/null | grep -q procd_tailscale.lock && n=$((n + 1))
done
echo "survivors=$(""" + SURVIVORS + """ | wc -l) holders=$n lock=$(test -e /var/lock/procd_tailscale.lock && echo present)"
"""

# The boot link of osi-bootstrap, replaced for a measured boot by a script
# that runs the real init and logs the uptime before and after. The stamp is
# read with the init's own test.
BOOTSTRAP_TIMER = """#!/bin/sh
# Test stand-in for the boot link: times the real init.
stamp=no
[ -f /etc/osi-bootstrap.done ] && [ -f /srv/node-red/.chirpstack.env ] &&
    grep -q 'CHIRPSTACK_APP_SENSORS=[0-9a-f]\\{8\\}-' /srv/node-red/.chirpstack.env 2>/dev/null && stamp=yes
logger -t osi-test-bootstrap "start uptime=$(cut -d' ' -f1 /proc/uptime) stamp=$stamp"
/etc/init.d/osi-bootstrap "$@"
rc=$?
logger -t osi-test-bootstrap "end uptime=$(cut -d' ' -f1 /proc/uptime) rc=$rc"
exit $rc
"""
BOOTSTRAP_LINE = re.compile(r' osi-test-bootstrap: (start|end) uptime=(\d+\.\d+) (?:stamp=(yes|no)|rc=(\d+))')
# A stamped boot start is two file tests and one grep; anything near this
# would mean the stamp was not taken.
BOOTSTRAP_LIMIT = 5.0

CONSOLE = b'Please press Enter to activate this console'
NO_MATCH = rb'OSI_CONSOLE_MARKER_THAT_NEVER_APPEARS_[0-9a-f]{40}'
# Group 1 is the two digits of the rc.d link: S<digits>tailscale.
RC_LINE = re.compile(r'procd: /etc/rc\.d/S(\d\d)tailscale: (.*)$')

# Lines as the image's logd writes them. BusyBox logger adds no pid, so the
# init's own give-up line reads "tailscale: ..." and the stand-in's
# "osi-test-cleanup: ...". The cleanup's output arrives through procd's rc.d
# runner ("procd: /etc/rc.d/S99tailscale: ..."), the daemon's output through
# its procd instance ("tailscaled[<pid>]: ..."). node-red.init logs the source
# of every ChirpStack setting on each start; its flows commit line appears only
# when it rewrites flows.json, so it is no boot marker.
NODE_RED_INIT = re.compile(r' node-red\.init: chirpstack config ')
GAVE_UP = re.compile(r'\.\w+ tailscale: ')
STAND_IN = re.compile(r'\.\w+ osi-test-cleanup: ')
DAEMON_START = re.compile(r' tailscaled\[\d+\]: .*Program starting: .*"--port"')
CTIME = re.compile(r'^\w{3} \w{3} +\d+ (\d\d):(\d\d):(\d\d) \d{4} ')
# A healthy cleanup returns within a second, also on a host about six times
# slower than the gate's. The boot is held when nothing starts long after.
HELD_SECONDS = 60
# The init counts its limit in `sleep 1` steps; under emulation each step runs
# a little long. A boot held for minutes fails this by far.
GIVE_UP_SLACK = 8
# How long a case waits after the farm page for the tailscale lines to land
# in the persistent log: S99tailscale runs after S99node-red.
LOG_SECONDS = 240


def free_port():
    import socket
    with socket.socket() as port:
        port.bind(('127.0.0.1', 0))
        return port.getsockname()[1]


def cleanup_limit(init_source):
    match = re.search(r'^OSI_CLEANUP_LIMIT=(\d+)$', init_source, re.M)
    if not match:
        raise ValueError('the OSI tailscale init does not set OSI_CLEANUP_LIMIT')
    return int(match.group(1))


def gave_up_line(limit):
    return f'cleanup did not finish in {limit} s; continuing without it'


def line_seconds(line):
    match = CTIME.match(line)
    if not match:
        raise RuntimeError('a syslog line has no time of day: ' + line[:60])
    hour, minute, second = (int(part) for part in match.groups())
    return hour * 3600 + minute * 60 + second


def first(lines, predicate, missing):
    for position, line in enumerate(lines):
        if predicate(line):
            return position, line
    raise RuntimeError(missing)


def tail_rc(lines):
    """Every line the boot runner captured from the tailscale init, with its link."""
    return [(position, 'S' + match.group(1) + 'tailscale', match.group(2))
            for position, line in enumerate(lines)
            if (match := RC_LINE.search(line))]


def stall_verdict(log, limit):
    """Judge a boot whose cleanup was made to stall; return its receipt."""
    lines = log.splitlines()
    started, _ = first(lines, lambda line: STAND_IN.search(line) and 'cleanup stall started' in line,
                       'the stalled cleanup did not announce itself in syslog')
    committed, _ = first(lines, NODE_RED_INIT.search, "Node-RED's init did not log its start")
    gave_up, gave_up_text = first(lines, lambda line: GAVE_UP.search(line) and gave_up_line(limit) in line,
                                  f'the init did not give up on the cleanup after {limit} s')
    daemon, daemon_text = first(lines, DAEMON_START.search,
                                'the tailscale daemon did not start after the cleanup was cut short')
    tailscale = tail_rc(lines)
    if any(link != 'S99tailscale' for _, link, _ in tailscale):
        links = ', '.join(sorted({link for _, link, _ in tailscale if link != 'S99tailscale'}))
        raise RuntimeError('the tailscale init ran from ' + links + ' instead of S99tailscale')
    if not committed < started < gave_up < daemon:
        raise RuntimeError(f'syslog order is wrong: Node-RED init at line {committed}, stall at {started}, '
                           f'give-up at {gave_up}, daemon at {daemon}')
    waited = (line_seconds(gave_up_text) - line_seconds(lines[started])) % 86400
    if not limit <= waited <= limit + GIVE_UP_SLACK:
        raise RuntimeError(f'the init gave up {waited} s after the stall began, not {limit} s')
    return (f'cleanup stalled {waited} s before the init gave up; Node-RED init came first; '
            'the daemon started with ' + daemon_text[daemon_text.index('--port'):].strip())


def normal_verdict(log, limit):
    """Judge a boot with the real cleanup; return its receipt."""
    lines = log.splitlines()
    tailscale = tail_rc(lines)
    if any(link != 'S99tailscale' for _, link, _ in tailscale):
        links = ', '.join(sorted({link for _, link, _ in tailscale if link != 'S99tailscale'}))
        raise RuntimeError('the tailscale init ran from ' + links + ' instead of S99tailscale')
    if any(STAND_IN.search(line) for line in lines):
        raise RuntimeError('the test stand-in was still installed')
    cleanup, _ = first(lines, lambda line: RC_LINE.search(line)
                       and 'Program starting' in line and '"--cleanup"' in line,
                       'the real cleanup did not run from S99tailscale')
    cut = next((position for position, line in enumerate(lines)
                if GAVE_UP.search(line) and gave_up_line(limit) in line), None)
    flushed = next((position for position, link, text in tailscale if 'flushing log.' in text
                    and position > cleanup), None)
    daemon = next((position for position, line in enumerate(lines) if DAEMON_START.search(line)), None)
    if cut is None and flushed is None:
        raise RuntimeError('the cleanup neither finished nor was cut short')
    if daemon is None or daemon <= cleanup:
        raise RuntimeError('the tailscale daemon did not start after its cleanup')
    if cut is not None:
        return f'cleanup was cut short after {limit} s and the daemon started'
    return 'cleanup finished with "flushing log." and the daemon started'


def install_stall(vm, wrapper=STALL_WRAPPER):
    checked(vm, """set -e
test ! -e /usr/sbin/tailscaled.real
mv /usr/sbin/tailscaled /usr/sbin/tailscaled.real
cat >/usr/sbin/tailscaled <<'OSI_STALL'
""" + wrapper + """OSI_STALL
chmod 755 /usr/sbin/tailscaled
sync
sha256sum /usr/sbin/tailscaled.real""")


def remove_stall(vm):
    checked(vm, """set -e
mv -f /usr/sbin/tailscaled.real /usr/sbin/tailscaled
sync
test ! -e /usr/sbin/tailscaled.real""")


def install_bootstrap_timer(vm):
    checked(vm, """set -e
test -L /etc/rc.d/S99osi-bootstrap
readlink /etc/rc.d/S99osi-bootstrap >/root/osi-test-bootstrap.link
rm /etc/rc.d/S99osi-bootstrap
cat >/etc/rc.d/S99osi-bootstrap <<'OSI_TIMER'
""" + BOOTSTRAP_TIMER + """OSI_TIMER
chmod 755 /etc/rc.d/S99osi-bootstrap
sync""")


def remove_bootstrap_timer(vm):
    checked(vm, """set -e
link=$(cat /root/osi-test-bootstrap.link)
rm -f /etc/rc.d/S99osi-bootstrap
ln -s "$link" /etc/rc.d/S99osi-bootstrap
rm -f /root/osi-test-bootstrap.link
sync
test -L /etc/rc.d/S99osi-bootstrap""")


def bootstrap_runs(log):
    """(seconds, stamp, rc) for each timed run of osi-bootstrap in a syslog extract."""
    runs, started, stamp = [], None, None
    for line in log.splitlines():
        match = BOOTSTRAP_LINE.search(line)
        if not match:
            continue
        if match.group(1) == 'start':
            started, stamp = float(match.group(2)), match.group(3)
        elif started is not None:
            runs.append((round(float(match.group(2)) - started, 2), stamp, int(match.group(4))))
            started = None
    return runs


def bootstrap_verdict(measured):
    """Judge every timed boot: [(label, [(seconds, stamp, rc), ...]), ...]."""
    flat = [(label, run) for label, runs in measured for run in runs]
    missing = [label for label, runs in measured if len(runs) != 1]
    if missing:
        raise RuntimeError('a measured boot did not time exactly one osi-bootstrap run: ' + ', '.join(missing))
    if len(flat) < 4:
        raise RuntimeError(f'only {len(flat)} boots were timed')
    for label, (seconds, stamp, rc) in flat:
        if stamp != 'yes' or rc != 0:
            raise RuntimeError(f'{label}: osi-bootstrap ran with stamp={stamp} and exited {rc}')
    worst_label, (worst, _, _) = max(flat, key=lambda item: item[1][0])
    if worst > BOOTSTRAP_LIMIT:
        raise RuntimeError(f'{worst_label}: the stamped osi-bootstrap start took {worst} s')
    return (f'{len(flat)} stamped boots; osi-bootstrap start to end '
            + ', '.join(f'{label} {run[0]:.2f} s' for label, run in flat) + f'; worst {worst:.2f} s ({worst_label})')


def lock_verdict(first, holders, second):
    """Judge a restart with a surviving cleanup, from RESTART and LOCK_HOLDERS output."""
    fields = dict(word.partition('=')[::2] for word in holders.split())
    state1, seconds1 = (first.split() + ['', ''])[:2]
    state2, seconds2 = (second.split() + ['', ''])[:2]
    if state1 != 'done':
        raise RuntimeError(f'the first restart did not finish: {first}')
    if fields.get('lock') != 'present':
        raise RuntimeError('procd did not take the service lock, so the case shows nothing')
    if not fields.get('survivors', '0').isdigit() or int(fields['survivors']) < 1:
        raise RuntimeError('no cleanup outlived its kill, so the case shows nothing: ' + holders)
    if fields.get('holders') != '0':
        raise RuntimeError(f'{fields.get("holders")} surviving cleanup(s) hold the procd lock: {holders}')
    if state2 != 'done':
        raise RuntimeError(f'the second restart waited on the lock: {second}')
    return (f'first restart {seconds1} s with its cleanups cut short; {fields["survivors"]} surviving cleanup '
            f'child(ren), none holding the procd lock; second restart {seconds2} s')


def mark_script(token, files=None):
    """logger, then wait until the line is in the persistent log.

    logd keeps the line in its ring; a separate `logread -F` writer appends it
    to the file later. A reboot right after `logger` can lose it.
    """
    names = ' '.join("'" + name + "'" for name in (files or SYSLOG_FILES))
    return (f'logger -t osi-test "{token}"\n'
            'i=0\n'
            f'until cat {names} 2>/dev/null | grep -qF \'{token}\'; do\n'
            '    i=$((i + 1)); [ "$i" -le 40 ] || exit 3; sleep 0.5\n'
            'done\n'
            'sync')


def mark(vm):
    """Write a marker to the persistent syslog and return it; a case reads its boot's log after it."""
    token = 'OSI-TAILSCALE-' + secrets.token_hex(6)
    try:
        checked(vm, mark_script(token), 60)
    except RuntimeError as error:
        raise RuntimeError('the marker did not reach the persistent syslog within 20 s') from error
    return token


SYSLOG_FILES = ('/data/log/osi-system.log.old', '/data/log/osi-system.log')


def boot_log_script(token, files=SYSLOG_FILES):
    """Shell that prints the tailscale-related syslog lines from the last marker on.

    It finds the marker's line number and tails from there: the persistent log
    runs to megabytes, and an awk that rebuilds one string per line takes
    minutes on the image's BusyBox.
    """
    names = ' '.join("'" + name + "'" for name in files)
    return (f"set -- {names}\n"
            f"n=$(cat \"$@\" 2>/dev/null | grep -n -F '{token}' | tail -n 1 | cut -d: -f1)\n"
            "[ -n \"$n\" ] || exit 0\n"
            "cat \"$@\" 2>/dev/null | tail -n +\"$n\" | "
            "grep -E 'tailscale|Tailscale|node-red\\.init: chirpstack config|osi-test'")


def boot_log(vm, token):
    """Syslog lines after the marker, from the file node-red.init keeps on /data."""
    return checked(vm, boot_log_script(token), 180)


def init_state(vm):
    output = checked(vm, """sha256sum /etc/init.d/tailscale | cut -d' ' -f1
for link in /etc/rc.d/S[0-9][0-9]tailscale; do
    [ -e "$link" ] || [ -L "$link" ] || continue
    echo "link $(basename "$link") $(readlink "$link")"
done
echo "daemon $(pidof tailscaled)" """)
    lines = output.splitlines()
    if not lines or not re.fullmatch(r'[0-9a-f]{64}', lines[0]):
        raise RuntimeError('could not read the tailscale init digest: ' + output[:80])
    links = [line[5:] for line in lines[1:] if line.startswith('link ')]
    daemon = next((line[7:] for line in lines if line.startswith('daemon ')), '')
    return {'sha': lines[0], 'links': links, 'daemon': daemon}


def image_receipt(vm):
    """What the factory image's read-only root carries; never fails a run."""
    try:
        lines = vm.command("ls /rom/etc/rc.d/ | grep -E '^[SK][0-9][0-9]tailscale$'; "
                           "echo digest $(sha256sum /rom/etc/init.d/tailscale 2>/dev/null | cut -d' ' -f1)")[1].splitlines()
    except Exception as error:  # diagnostics only
        return f'unreadable ({error!r})'
    digest = next((line[7:] for line in lines if line.startswith('digest ')), '')
    links = [line for line in lines if not line.startswith('digest ')]
    return f'{",".join(links) or "no boot link"}, init digest {digest[:12] or "absent"}'


def init_digest(release):
    import hashlib
    return hashlib.sha256((release/INIT).read_bytes()).hexdigest()


def installed(state, release):
    digest = init_digest(release)
    if state['sha'] != digest:
        raise RuntimeError(f'the installed tailscale init has digest {state["sha"][:12]}, the release ships {digest[:12]}')
    if state['links'] != ['S99tailscale ../init.d/tailscale']:
        raise RuntimeError('tailscale boot links are ' + (', '.join(state['links']) or 'none') + ', expected S99tailscale only')


# The offline install with its trace kept on the guest: a failure before
# deploy.sh starts (mount, checksum, cache, launcher) leaves no deploy log.
TRACED_INSTALL = ('exec 2>/tmp/osi-install.trace\nset -x\n'
                  + CANDIDATE_INSTALL.replace('--wait >/dev/null 2>&1', '--wait >/tmp/osi-install.out 2>&1'))
INSTALL_DIAGNOSTICS = """sync
echo "deploy logs: $(ls -t /data/deploy-*.log 2>/dev/null | head -3 | tr '\\n' ' ')"
echo '--- trace'; tail -n 25 /tmp/osi-install.trace 2>/dev/null
echo '--- installer'; tail -n 40 /tmp/osi-install.out 2>/dev/null
f=$(ls -t /data/deploy-*.log 2>/dev/null | head -1)
[ -n "$f" ] && { echo "--- $f"; tail -n 40 "$f"; }
echo '--- df'; df -k /tmp /data 2>/dev/null"""


def install_candidate(vm, release):
    code, _ = vm.command('set -e\n' + TRACED_INSTALL, 2400)
    if code:
        _, diagnostics = vm.command(INSTALL_DIAGNOSTICS)
        (vm.receipts/f'install-failure-{vm.boots}.log').write_text(diagnostics + '\n')
        tail = ' | '.join(line for line in diagnostics.splitlines()[-6:] if line.strip())
        raise RuntimeError(f'offline installer exited {code}; see install-failure-{vm.boots}.log: {tail[:400]}')


def drain_console(vm, seconds):
    """Read the console for `seconds` so the guest never blocks on it; say whether its login prompt came up.

    The prompt says nothing about the rc.d scripts (see CONSOLE).
    """
    deadline = time.monotonic() + seconds
    seen = False
    while True:
        remaining = deadline - time.monotonic()
        if remaining <= 0:
            return seen
        try:
            vm.expect(NO_MATCH, min(1.0, remaining))
        except TimeoutError:
            pass
        at = vm.buf.find(CONSOLE)
        if at >= 0:
            vm.buf = vm.buf[at + len(CONSOLE):]
            seen = True


def parse_fields(output):
    """`name=value` words, whitespace separated; a name without a value is absent."""
    return {name: value for name, _, value in (word.partition('=') for word in output.split()) if value}


def held_state(output):
    """(ChirpStack pid or '', other lines) from HELD_STATE's output."""
    lines = [line.strip() for line in output.splitlines() if line.strip() and not line.startswith('age=')]
    pid = lines[0] if lines and lines[0].isdigit() else ''
    return pid, [line for line in lines if not line.isdigit()]


def process_starts(output, now):
    """Seconds after the boot began for each `name <seconds ago>` line.

    `now` is the host time, in seconds after the boot began, of the reading.
    A process start is read from /proc/<pid>/stat in the guest, so it does not
    depend on when the guest is asked.
    """
    starts = {}
    for line in output.splitlines():
        name, _, ago = line.partition(' ')
        if ago.strip().isdigit():
            starts[name] = max(0.0, now - int(ago))
    return starts


PROCESS_STARTS = """up=$(cut -d. -f1 /proc/uptime)
for name in DAEMON chirpstack; do
    p=$(pidof "$name" | cut -d' ' -f1)
    [ -n "$p" ] && echo "$name $(( up - $(cut -d' ' -f22 /proc/$p/stat) / 100 ))"
done
p=$(pgrep -f 'node-re[d]' | head -1)
[ -n "$p" ] && echo "node-red $(( up - $(cut -d' ' -f22 /proc/$p/stat) / 100 ))"
"""


def since_boot(vm):
    return time.monotonic() - vm.started


def record_processes(vm, daemon, note, record):
    """Record when the daemon, ChirpStack and Node-RED started, in seconds after the boot began."""
    before = since_boot(vm)
    output = vm.command(PROCESS_STARTS.replace('DAEMON', daemon))[1]
    after = since_boot(vm)
    starts = process_starts(output, (before + after) / 2)
    record(f'{note}: process starts in seconds after the boot began: ' + ', '.join(f'{name} {starts[name]:.0f}'
           for name in (daemon, 'chirpstack', 'node-red') if name in starts))
    return starts


def lan_ssh(port, key, command, timeout=30):
    """Run one command on the guest over its LAN address as root.

    The key is installed on the first boot, before any boot is held, so the
    login itself is never what a case measures. The command still runs the
    way a technician's does: dropbear hands it to `sh -c`, whose command line
    carries the lookup's own pattern.
    """
    options = ['-p', str(port), '-i', str(key), '-o', 'IdentitiesOnly=yes', '-o', 'BatchMode=yes',
               '-o', 'StrictHostKeyChecking=no', '-o', 'UserKnownHostsFile=/dev/null',
               '-o', 'LogLevel=ERROR', '-o', 'ConnectTimeout=5']
    try:
        done = subprocess.run(['ssh', *options, 'root@127.0.0.1', command], capture_output=True, text=True,
                              timeout=timeout, stdin=subprocess.DEVNULL)
    except subprocess.TimeoutExpired:
        return 255, '', f'ssh timed out after {timeout} s'
    return done.returncode, done.stdout.strip(), done.stderr.strip()


def ssh_key(directory):
    key = directory/'tailscale-lan-key'
    if not key.exists():
        subprocess.run(['ssh-keygen', '-q', '-t', 'ed25519', '-N', '', '-C', 'osi-emulator', '-f', str(key)],
                       check=True, stdin=subprocess.DEVNULL)
    return key, (directory/'tailscale-lan-key.pub').read_text().strip()


def run(args, run_dir, scratch, release, make_guest, test, record, fixture_archive, media, ready):
    limit = cleanup_limit((release/INIT).read_text())
    healthy = [True]
    bootstrap_timed = []
    guests = []

    def guest(name, image, **options):
        vm = make_guest(scratch/f'tailscale-{name}', image, args.qemu, args.ram,
                        receipts=run_dir/f'tailscale-{name}', **options)
        guests.append((scratch/f'tailscale-{name}', run_dir/f'tailscale-{name}'))
        return vm

    def keep_stderr():
        # The scratch directory is deleted after the run; QEMU's own errors
        # are the first thing a failed launch needs.
        for work, receipts in guests:
            for path in sorted(work.glob('*.stderr')):
                try:
                    receipts.mkdir(parents=True, exist_ok=True)
                    (receipts/path.name).write_bytes(path.read_bytes())
                except OSError as error:
                    record(f'could not keep {path.name}: {error!r}')

    def boot_log_of(vm, token, verdict, name):
        log = boot_log(vm, token)
        (run_dir/f'tailscale-{name}-{vm.boots}.syslog').write_text(log)
        if token not in log:
            raise RuntimeError('the marker written before the reboot is not in the persistent syslog')
        return verdict(log, limit)

    def judged(vm, token, verdict, name):
        """The verdict on this boot's syslog, read until it passes or LOG_SECONDS have gone."""
        deadline = time.monotonic() + LOG_SECONDS
        while True:
            try:
                return boot_log_of(vm, token, verdict, name)
            except RuntimeError:
                if time.monotonic() >= deadline:
                    raise
            time.sleep(10)

    def version(vm):
        return vm.command('uci get osi-server.cloud.firmware_version')[1]

    def daemon_runs(vm, name='tailscaled'):
        if not vm.command(f'pidof {name}')[1]:
            raise RuntimeError(f'the tailscale daemon ({name}) is not running')

    # The four deploy-side cases share one guest: an earlier failure leaves it
    # in an unknown state, so the later ones are then reported as not run.
    def chained(case):
        def run_case():
            if not healthy[0]:
                raise RuntimeError('not run: an earlier tailscale case failed on this guest')
            try:
                return case()
            except BaseException:
                healthy[0] = False
                raise
        return run_case

    # `media` builds the offline release once and returns its path.
    upgraded = guest('upgraded', fixture_archive('0.8.0'), upgrade=media())

    def installed_by_deploy():
        upgraded.start()
        ready(upgraded)
        before = init_state(upgraded)
        record(f'0.8.0 tailscale init before the deploy: {before}')
        if version(upgraded) != '0.8.0':
            raise RuntimeError('fixture firmware version mismatch')
        if before['links'] != ['S80tailscale ../init.d/tailscale'] or not before['daemon']:
            raise RuntimeError('the 0.8.0 fixture does not show the package layout: ' + str(before))
        install_candidate(upgraded, release)
        after_deploy = init_state(upgraded)
        record(f'tailscale init after the deploy: {after_deploy}')
        installed(after_deploy, release)
        if after_deploy['daemon'] != before['daemon']:
            raise RuntimeError('the deploy restarted tailscaled')
        if version(upgraded) != args.osi_version:
            raise RuntimeError('offline installer did not reach the candidate version')
        return 'package file replaced, boot link S80 to S99, tailscaled kept pid ' + after_deploy['daemon']

    def timed(vm, token, label):
        log = boot_log(vm, token)
        (run_dir/f'tailscale-bootstrap-{label.replace(" ", "-")}.syslog').write_text(log)
        runs = bootstrap_runs(log)
        bootstrap_timed.append((label, runs))
        record(f'{label}: osi-bootstrap start to end (seconds, stamp, exit): {runs}')

    def stalled_boot():
        install_stall(upgraded)
        install_bootstrap_timer(upgraded)
        token = mark(upgraded)
        upgraded.upgrade_reboot('sync && reboot', launch_only=True)
        upgraded.expect(CONSOLE, SLOW_BOOT_SECONDS)
        prompt = since_boot(upgraded)
        upgraded.shell()
        ready(upgraded)
        page = since_boot(upgraded)
        receipt = judged(upgraded, token, stall_verdict, 'stall')
        timed(upgraded, token, 'upgraded guest, stalled cleanup')
        record(f'boot with the stalled cleanup: login prompt {prompt:.0f} s, farm page and ChirpStack '
               f'{page:.0f} s after the boot began')
        record_processes(upgraded, 'tailscaled.real', 'boot with the stalled cleanup', record)
        if upgraded.command(STALLED_CLEANUP)[1]:
            raise RuntimeError('the stalled cleanup is still running')
        daemon_runs(upgraded, 'tailscaled.real')
        return receipt

    def normal_boot():
        remove_stall(upgraded)
        token = mark(upgraded)
        upgraded.upgrade_reboot('sync && reboot', launch_only=True)
        upgraded.expect(CONSOLE, SLOW_BOOT_SECONDS)
        prompt = since_boot(upgraded)
        upgraded.shell()
        ready(upgraded)
        page = since_boot(upgraded)
        receipt = judged(upgraded, token, normal_verdict, 'normal')
        timed(upgraded, token, 'upgraded guest, normal boot')
        remove_bootstrap_timer(upgraded)
        record(f'boot without the stall: login prompt {prompt:.0f} s, farm page and ChirpStack '
               f'{page:.0f} s after the boot began')
        record_processes(upgraded, 'tailscaled', 'boot without the stall', record)
        daemon_runs(upgraded)
        return receipt

    def restart_with_survivor():
        # A cleanup that outlives its kill must not keep procd's lock on the
        # service: the next `/etc/init.d/tailscale restart` would wait on it.
        install_stall(upgraded, SURVIVOR_WRAPPER)
        restart = RESTART.replace('RESTART_LIMIT', str(RESTART_LIMIT))
        try:
            first = checked(upgraded, restart, RESTART_LIMIT + 60)
            holders = checked(upgraded, LOCK_HOLDERS)
            second = checked(upgraded, restart, RESTART_LIMIT + 60)
            record(f'restart with a surviving cleanup: first {first}; {holders}; second {second}')
            receipt = lock_verdict(first, holders, second)
            daemon_runs(upgraded, 'tailscaled.real')
            return receipt
        finally:
            upgraded.command('for p in $(' + SURVIVORS + '); do kill "$p"; done')
            remove_stall(upgraded)

    def left_alone():
        # A package that ships another init file and another boot position.
        checked(upgraded, """set -e
cp /rom/etc/init.d/tailscale /etc/init.d/tailscale
sed -i 's/^START=80$/START=85/' /etc/init.d/tailscale
rm -f /etc/rc.d/S99tailscale
ln -s ../init.d/tailscale /etc/rc.d/S85tailscale
sync""")
        before = init_state(upgraded)
        install_candidate(upgraded, release)
        after_deploy = init_state(upgraded)
        record(f'tailscale init with a foreign package file after the deploy: {after_deploy}')
        if after_deploy != before:
            raise RuntimeError('the deploy changed a tailscale init that is neither the 1.80.3-r1 file nor its own')
        lines = checked(upgraded, """f=$(ls -t /data/deploy-*.log | head -1)
sed -n '/--- Tailscale boot init ---/,$p' "$f" """)
        step = lines.split('=== Deploy complete. ===')[0].splitlines()
        banner = lines.split('=== Deploy complete. ===')[1].splitlines()
        warning = ('WARN: tailscale boot protection NOT installed: /etc/init.d/tailscale is neither '
                   'the tailscale 1.80.3-r1 package file nor the OSI copy; the file was left unchanged')
        said = [line.strip() for line in step if line.strip()]
        if said != ['--- Tailscale boot init ---', warning] or warning not in [line.strip() for line in banner]:
            raise RuntimeError('the deploy did not leave the foreign init alone with one WARN line, repeated in the '
                               'banner: ' + ' | '.join(said) + ' // ' + ' | '.join(line.strip() for line in banner if 'tailscale' in line))
        return 'foreign package file and its S85 link untouched; one WARN line, repeated in the banner; deploy completed'

    def recovery(vm, ssh, began):
        """Seconds from the kill until each milestone of the on-site document, read over LAN SSH."""
        seen = {}
        prompted = False
        while len(seen) < 4 and time.monotonic() - began < SLOW_BOOT_SECONDS:
            output = ssh(MILESTONES)[1]
            for name, value in parse_fields(output).items():
                seen.setdefault(name, time.monotonic() - began)
            prompted |= drain_console(vm, 2)
        return seen, prompted

    def one_held_boot(vm, ssh, command, name):
        """Hold a boot at the cleanup, end it with `command`, and time the recovery.

        All evidence of the hold comes over LAN SSH: the console prompt comes
        up while rc.d is still held (see CONSOLE). The console is read
        throughout so the guest never blocks on it.
        """
        token = mark(vm)
        vm.upgrade_reboot('sync && reboot', launch_only=True)
        deadline = time.monotonic() + SLOW_BOOT_SECONDS
        stalled, error, prompted = '', '', False
        while not stalled and time.monotonic() < deadline:
            prompted |= drain_console(vm, 3)
            code, stalled, error = ssh(STALLED_CLEANUP)
        if not stalled:
            raise RuntimeError('the stalled cleanup was not found over LAN SSH: ' + error)
        # One pid from each lookup: two would mean the lookup matched the
        # shell running it, none that it cannot see the cleanup.
        found = {}
        for label, lookup in (('pgrep', STALLED_CLEANUP), ('ps and awk', PS_LOOKUP), ('on-site document', ONSITE_LOOKUP)):
            code, found[label], error = ssh(lookup)
        wrong = {label: pids for label, pids in found.items() if pids.split() != stalled.split()}
        if wrong:
            raise RuntimeError(f'the lookups do not name the same single cleanup pid (pgrep found {stalled!r}): {wrong}')
        held_from = time.monotonic()
        prompted |= drain_console(vm, HELD_SECONDS)
        code, output, error = ssh(HELD_STATE)
        chirpstack_pid, others = held_state(output)
        age = parse_fields(output).get('age', '')
        record(f'{name}: boot held for {time.monotonic() - held_from:.0f} s at the stalled cleanup {stalled}, '
               f'which had then run {age or "?"} s; ChirpStack pid {chirpstack_pid or "none"}; '
               f'other output: {" ".join(others) or "none"}; console prompt up: {"yes" if prompted else "no"}')
        if chirpstack_pid or others:
            raise RuntimeError('services started although the cleanup was still stalled: ' + output.replace(chr(10), ' '))
        if not age.isdigit() or int(age) < HELD_SECONDS:
            raise RuntimeError(f'the stalled cleanup had run {age or "an unknown number of"} s, not at least {HELD_SECONDS} s')
        killed_at = time.monotonic()
        code, _, error = ssh(command)
        if code:
            raise RuntimeError(f'the line failed over LAN SSH: {command}: {error}')
        seen, later = recovery(vm, ssh, killed_at)
        if not (prompted or later):
            vm.expect(CONSOLE, SLOW_BOOT_SECONDS)
        vm.shell()
        ready(vm)
        daemon_runs(vm, 'tailscaled.real')
        timed(vm, token, name)
        order = (('the Tailscale daemon', 'daemon'), ('ChirpStack', 'chirpstack'), ('the Node-RED process', 'node'),
                 ('the farm page', 'gui'))
        missing = [label for label, milestone in order if milestone not in seen]
        if missing:
            raise RuntimeError(f'after the kill these did not come up within {SLOW_BOOT_SECONDS} s: {missing}')
        record(f'{name}: seconds from the kill until: ' + ', '.join(f'{label} {seen[milestone]:.0f}' for label, milestone in order))
        return ', '.join(f'{label} {seen[milestone]:.0f} s' for label, milestone in order)

    def fallback():
        # The package init at S80 with a stalled cleanup: the state a gateway
        # on the field image is in. The case reaches the gateway over its LAN
        # address, as a technician does, and runs the kill lines there.
        # Two rounds: the runbook's line, then the on-site document's.
        vm = guest('fallback', fixture_archive('0.8.0'))
        port = free_port()
        vm.extra_hostfwd.append((port, 22))
        key, public = ssh_key(scratch)

        def ssh(command):
            return lan_ssh(port, key, command)

        try:
            vm.start()
            ready(vm)
            checked(vm, """set -e
uci set network.lan.proto='static'
uci set network.lan.ipaddr='192.0.2.15'
uci set network.lan.netmask='255.255.255.0'
uci commit network
mkdir -p /etc/dropbear
printf '%s\\n' '""" + public + """' >>/etc/dropbear/authorized_keys
chmod 700 /etc/dropbear
chmod 600 /etc/dropbear/authorized_keys
sync""")
            code, said, error = ssh('echo osi-lan-ssh')
            if said != 'osi-lan-ssh':
                raise RuntimeError(f'LAN SSH does not reach the guest before the stall (exit {code}): {error}')
            install_stall(vm)
            install_bootstrap_timer(vm)
            timings = [one_held_boot(vm, ssh, TECHNICIAN_COMMAND, 'fallback round 1, the runbook line'),
                       one_held_boot(vm, ssh, ONSITE_COMMAND, 'fallback round 2, the on-site document line')]
            return ('two boots held at S80tailscale, each for at least 60 s with no ChirpStack or Node-RED; pgrep, '
                    'ps and awk, and the on-site lookup named the same cleanup pid; after the kill, from the kill: '
                    + '; '.join(timings))
        finally:
            vm.stop()

    try:
        test(INSTALLED_CASE, chained(installed_by_deploy))
        test(STALL_CASE, chained(stalled_boot))
        test(NORMAL_CASE, chained(normal_boot))
        test(LOCK_CASE, chained(restart_with_survivor))
        test(REFUSAL_CASE, chained(left_alone))
    finally:
        healthy[0] = False
        upgraded.stop()
    try:
        test(FALLBACK_CASE, fallback)
        test(BOOTSTRAP_CASE, lambda: bootstrap_verdict(bootstrap_timed))
    finally:
        keep_stderr()
