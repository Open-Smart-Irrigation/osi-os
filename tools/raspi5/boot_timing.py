"""Boot-phase timing from a guest's syslog: what a slow boot spent its time on.

After an API wait past SLOW_API_SECONDS the harness keeps three things for the
case (upgrade_suite.wait_for_api calls keep): this boot's phase lines of the
guest's persistent syslog, their timing, and a one-line summary on the case's
results line. By hand, on a kept log:

    python3 boot_timing.py SYSLOG [--api-answer "Sun Apr 13 16:51:09 2025"] [--json]

A syslog carries no request log. The first /api/me answer therefore comes from
the API wait, which prints the guest clock at the first 401; read without it,
a log reports the answer as absent.
"""
import argparse
import json
from pathlib import Path
import re
import sys

from suite_vm import note_wait

# An API wait longer than this keeps the boot's phase timing. The Pi 5 budget
# (420 s) never reaches it on a pass; the Pi 4's (900 s) can.
SLOW_API_SECONDS = 600
# The persistent syslog sink node-red.init keeps on /data; logd renames it to
# .old when it passes its size.
SYSLOG = '/data/log/osi-system.log'
READ_SECONDS = 300

# The time of day logd puts on every line (tailscale_boot.CTIME reads the same).
CTIME = re.compile(r'^\w{3} \w{3} +\d+ (\d\d):(\d\d):(\d\d) \d{4} ')
BOOTSTRAP_START = re.compile(r' osi-bootstrap: waiting for ChirpStack gRPC\.\.\.')
# The last line osi-bootstrap logs in a boot, whichever way its run went.
BOOTSTRAP_DONE = re.compile(r' osi-bootstrap: (?:Node-RED restart re|identityd is not ready|bootstrap completed but'
                            r'|bootstrap failed|ChirpStack not ready)')
# First-boot work besides the bootstrap: the LoRaWAN device import, which
# arrives through procd's rc.d runner.
DEVICE_IMPORT = re.compile(r'procd: /etc/rc\.d/S99zzz-lorawan-devices\.init: ')
NODE_RED = re.compile(r' node\[(\d+)\]: (?:\d\d \w{3} \d\d:\d\d:\d\d - \[info\] )?'
                      r'(Welcome to Node-RED|Loading palette nodes|Settings file|Server now running at)')
# Node-RED logs "Settings file" first once its palette nodes are loaded, and
# "Server now running" when /api/me can answer.
NODE_RED_STEPS = {'Welcome to Node-RED': 'started', 'Loading palette nodes': 'node_load_start',
                  'Settings file': 'node_load_end', 'Server now running at': 'listening'}
CLOCKED = ('started', 'node_load_start', 'node_load_end', 'listening')

# The device import writes thousands of lines, too many for the console. awk
# keeps the first line of a block and the last one before the next phase line,
# each in its place, so every phase line comes through once.
AWK = ("/S99zzz-lorawan-devices\\.init: / { if (!seen) print; else { last = $0; pending = 1 }; seen = 1; next }\n"
       "/osi-bootstrap|S99osi-bootstrap|Welcome to Node-RED|Loading palette nodes|Settings file|Server now running/ "
       "{ if (pending) { print last; pending = 0 } print }\n"
       "END { if (pending) print last }")


def read_script(first_line):
    """Guest shell that prints the phase lines of the syslog from line `first_line` on.

    `first_line` is the line after the ones the console's probe found when this
    boot's console answered (Guest.LOG_COUNT). A log rotated since then is read
    on from its .old file; a guest without a persistent syslog is read from the
    boot's ring.
    """
    syslog, rotated = SYSLOG, SYSLOG + '.old'
    return (f'{{ if [ -f "{syslog}" ]; then\n'
            f'    if [ "$(wc -l < "{syslog}")" -ge {first_line} ]; then tail -n +{first_line} "{syslog}"\n'
            f'    else tail -n +{first_line} "{rotated}" 2>/dev/null || :; cat "{syslog}"; fi\n'
            f'else logread; fi; }} | awk \'{AWK}\'\n')


def line_time(line):
    """Seconds of the day of a syslog line, or None for a line without a time."""
    match = CTIME.match(line)
    return None if match is None else int(match[1]) * 3600 + int(match[2]) * 60 + int(match[3])


def clock(seconds):
    return f'{seconds // 3600:02d}:{seconds // 60 % 60:02d}:{seconds % 60:02d}'


def span(start, end):
    """A phase as a receipt shows it: the guest clock at both ends and its length, None where the log stops first."""
    return {'start': clock(start), 'end': None if end is None else clock(end),
            'seconds': None if end is None else (end - start) % 86400}


def boot_phases(log, api_answer=None):
    """Timing of one boot's phases, from its syslog lines.

    Each phase is taken from its last run in the log. A phase the log does not
    finish has no end. `api_answer` is the guest clock the API wait printed at
    the first 401.
    """
    timed = []
    for line in log.splitlines():
        at = line_time(line)
        if at is not None:
            timed.append((len(timed), at, line))
    boots = []    # each osi-bootstrap run: where and when it began, where and when it ended
    imports = []  # each device-import line: where and when
    runs = []
    for where, at, line in timed:
        if BOOTSTRAP_START.search(line):
            boots.append([where, at, None, None])
        elif boots and boots[-1][2] is None and BOOTSTRAP_DONE.search(line):
            boots[-1][2:] = [where, at]
        if DEVICE_IMPORT.search(line):
            imports.append((where, at))
        found = NODE_RED.search(line)
        if not found:
            continue
        step = NODE_RED_STEPS[found[2]]
        if step == 'started':
            runs.append({'pid': found[1], 'started': at, 'node_load_start': None, 'node_load_end': None,
                         'listening': None})
        elif runs and runs[-1]['pid'] == found[1] and runs[-1][step] is None:
            runs[-1][step] = at
    bootstrap = boots[-1] if boots else None
    # Of several first boots in one file, the phases belong to the last one.
    imports = [entry for entry in imports if bootstrap is None or entry[0] > bootstrap[0]]
    work = [entry for entry in (bootstrap, imports[0] + imports[-1] if imports else None) if entry is not None]
    if not work:
        first_boot_work = None
    else:
        ends = [entry for entry in work if entry[2] is not None]
        first_boot_work = span(min(work, key=lambda entry: entry[0])[1],
                               max(ends, key=lambda entry: entry[2])[3] if ends else None)
    for run in runs:
        run['node_load_seconds'] = (None if run['node_load_start'] is None or run['node_load_end'] is None
                                    else (run['node_load_end'] - run['node_load_start']) % 86400)
    # The wait prints the clock without the space logd's lines continue with.
    answer = line_time(api_answer + ' ') if api_answer else None
    return {
        'log': {'lines': len(log.splitlines()),
                'first': clock(timed[0][1]) if timed else None, 'last': clock(timed[-1][1]) if timed else None},
        'first_boot_work': first_boot_work,
        'osi_bootstrap': span(bootstrap[1], bootstrap[3]) if bootstrap else None,
        'device_import': span(imports[0][1], imports[-1][1]) if imports else None,
        'node_red': [{key: clock(value) if key in CLOCKED and value is not None else value
                      for key, value in run.items()} for run in runs],
        'api_answer': clock(answer) if answer is not None else None,
    }


def spanned(name, phase):
    """One line for a phase: both ends and its length, or what the log leaves of it."""
    if phase is None:
        return f'{name}: none in this log'
    if phase['end'] is None:
        return f"{name}: {phase['start']}, not finished in this log"
    return f"{name}: {phase['start']} to {phase['end']} ({phase['seconds']} s)"


def format_phases(phases):
    """The timing as receipt lines."""
    log, work = phases['log'], phases['first_boot_work']
    lines = [f"guest syslog: {log['lines']} lines, {log['first']} to {log['last']}", spanned('first-boot work', work)]
    if work is not None:
        lines += ['  ' + spanned('osi-bootstrap', phases['osi_bootstrap']),
                  '  ' + spanned('device import', phases['device_import'])]
    for run in phases['node_red']:
        if run['node_load_start'] is None:
            load = 'node load not begun in this log'
        elif run['node_load_end'] is None:
            load = f"node load from {run['node_load_start']}, not finished in this log"
        else:
            load = f"node load {run['node_load_start']} to {run['node_load_end']} ({run['node_load_seconds']} s)"
        listening = f", API listening {run['listening']}" if run['listening'] is not None else ''
        lines.append(f"Node-RED {run['pid']}: started {run['started']}, {load}{listening}")
    if not phases['node_red']:
        lines.append('Node-RED: no start in this log')
    answer = phases['api_answer']
    lines.append('first /api/me answer: none in this evidence' if answer is None
                 else f'first /api/me answer: {answer} (guest clock, read by the API wait)')
    return '\n'.join(lines)


def summarize(phases):
    """One line, for the results line of the case."""
    parts = []
    work = phases['first_boot_work']
    if work is None:
        parts.append('no first-boot work in the log')
    else:
        parts.append(f"first-boot work {work['start']}, not finished" if work['end'] is None
                     else f"first-boot work {work['start']} to {work['end']}")
    for name, key in (('osi-bootstrap', 'osi_bootstrap'), ('device import', 'device_import')):
        if phases[key] is not None:
            parts.append(f"{name} not finished" if phases[key]['end'] is None
                         else f"{name} {phases[key]['seconds']} s")
    if not phases['node_red']:
        parts.append('Node-RED did not start in the log')
    for run in phases['node_red']:
        if run['node_load_start'] is None:
            parts.append(f"Node-RED {run['pid']} before its node load")
        elif run['node_load_end'] is None:
            parts.append(f"Node-RED {run['pid']} node load not finished")
        else:
            parts.append(f"Node-RED {run['pid']} node load {run['node_load_seconds']} s")
    parts.append('no first /api/me answer' if phases['api_answer'] is None
                 else f"first /api/me answer {phases['api_answer']}")
    return ', '.join(parts)


def keep(vm, answer):
    """After a slow API wait: keep this boot's phases in the case receipts and on its results line.

    Nothing here may fail the wait that passed: a guest that cannot be read, or
    a receipt that cannot be written, is said on the results line instead.
    """
    if vm.private:
        return
    # Here, not at the top: upgrade_suite imports this module.
    from upgrade_suite import checked
    try:
        log = checked(vm, read_script(vm.log_from + 1), READ_SECONDS)
        (vm.receipts/f'boot-timing-{vm.boots}.syslog').write_text(log + '\n')
        phases = boot_phases(log, answer)
        (vm.receipts/f'boot-timing-{vm.boots}.txt').write_text(format_phases(phases) + '\n')
    except Exception as error:
        note_wait(vm, f'boot timing not kept: {error!r}')
        return
    # keep() runs only after a passed wait, so the API did answer.
    note_wait(vm, 'boot timing: ' + summarize(phases)
              + ('' if phases['api_answer'] else '; the API wait printed no guest clock'))


def main(argv=None):
    parser = argparse.ArgumentParser(description='Boot-phase timing from a guest syslog.')
    parser.add_argument('syslog', type=Path)
    parser.add_argument('--api-answer', help='the guest clock the API wait printed at the first 401')
    parser.add_argument('--json', action='store_true', help='print the phases as JSON')
    args = parser.parse_args(argv)
    phases = boot_phases(args.syslog.read_text(errors='replace'), args.api_answer)
    print(json.dumps(phases, indent=2) if args.json else format_phases(phases))
    return 0


if __name__ == '__main__':
    sys.exit(main())
